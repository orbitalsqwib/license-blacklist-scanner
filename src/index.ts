import { env } from "node:process";
import { App } from "octokit";
import packageJson from "package-json";

const appId = env.GH_APP_ID;
const privateKey = env.GH_APP_PRIVATE_KEY;
const orgUrl = env.GH_ORG_URL;
const installationId = env.GH_ORG_INSTALLATION_ID;
const licenseBlacklist = env.LICENSE_BLACKLIST;
const slackWebhookUrl = env.SLACK_WEBHOOK_URL;

interface PackageData {
	name: string;
	version: string;
	license: string;
}
interface MappedPackageData {
	repo: string;
	version: string;
}
type PackageDataMap = Map<string, Map<string, MappedPackageData[]>>;

const resolveLicenseFromNPM = async (pkgName: string, version?: string) =>
	packageJson(pkgName, {
		fullMetadata: true,
		version,
	})
		.then((pkgJson) => (pkgJson.license as string | undefined) ?? "Unknown")
		.catch(() => "Unknown");

const run = async () => {
	if (!appId || !privateKey || !installationId)
		throw new Error("missing credentials!");

	if (!licenseBlacklist) throw new Error("no blacklist provided!");
	const blacklist = licenseBlacklist.split(",");

	if (!orgUrl) throw new Error("no organisation github URL provided!");
	const orgName = new URL(orgUrl).pathname.replace("/", "");

	// initialize github app credentials
	const app = new App({
		appId,
		privateKey: privateKey.replace(/\\n/gm, "\n"),
	});

	// get installation scoped access
	const octokit = await app.getInstallationOctokit(
		Number.parseInt(installationId),
	);

	// check authentication works before proceeding
	const { data } = await octokit.request("/app");
	if (!data) throw new Error("authentication failed");

	console.log("authenticated as %s", data.name);

	// retrieve all repos available on the installation
	const orgRepos = await octokit
		.request("GET /orgs/{org}/repos", {
			org: orgName,
		})
		.catch(() => {
			throw new Error(`failed to retrieve repos for org ${orgName}`);
		})
		.then((res) => res.data)
		.then((repos) => repos.filter((repo) => repo.name !== ".github"));

	// retrieve all packages from available repositories
	const pkgsByRepo = await Promise.all(
		orgRepos.map(({ name, owner }) => {
			return octokit
				.request("GET /repos/{owner}/{repo}/dependency-graph/sbom", {
					owner: owner.login,
					repo: name,
				})
				.catch(() => {
					throw new Error(`failed to retrieve repos for org ${orgName}`);
				})
				.then(async (res) => ({
					repo: name,
					packages: await Promise.all(
						res.data.sbom.packages
							.filter((pkg) => pkg.name && pkg.versionInfo !== "main")
							.map(async ({ name, versionInfo, licenseConcluded }) => {
								// resolve package licenses on a best effort basis
								const license = (
									licenseConcluded ??
									(await resolveLicenseFromNPM(name as string, versionInfo))
								).replace(/ /g, "-");

								return {
									name: name,
									version: versionInfo ?? "Missing version data",
									license,
								} as PackageData;
							}),
					),
				}));
		}),
	);

	// use maps to quickly organise raw data
	const blacklistMap = new Map() as PackageDataMap;
	const noLicenseMap = new Map() as PackageDataMap;
	const insertPkgIntoMap = (
		repo: string,
		pkg: PackageData,
		map: PackageDataMap,
	) => {
		const { name, version, license } = pkg;
		if (!map.has(name)) {
			map.set(name, new Map<string, MappedPackageData[]>());
		}
		if (!map.get(name)?.has(license)) {
			map.get(name)?.set(license, []);
		}
		map.get(name)?.get(license)?.push({ repo, version });
	};

	pkgsByRepo.forEach(({ repo, packages }) => {
		packages.forEach((pkg) => {
			if (pkg.license === "Unknown") {
				insertPkgIntoMap(repo, pkg, noLicenseMap);
			}
			if (blacklist.includes(pkg.license)) {
				insertPkgIntoMap(repo, pkg, blacklistMap);
			}
		});
	});

	// convert maps to arrays for convenience
	const arraifyMap = (map: typeof blacklistMap) =>
		Array.from(map, ([k, v]) => ({
			name: k,
			licenses: Array.from(v, ([k, v]) => ({
				license: k,
				repos: v,
			})),
		}));

	const blacklistPkgs = arraifyMap(blacklistMap);
	const noLicensePkgs = arraifyMap(noLicenseMap);

	// format arrays into markdown for readability
	const generateMDFromPkgs = (pkgsCategory: "blacklisted" | "missing") =>
		`### Dependencies with ${pkgsCategory} licenses\n` +
		`| Package Name | License | Repositories Affected |\n` +
		`| --- | --- | --- |\n` +
		`${(pkgsCategory === "blacklisted" ? blacklistPkgs : noLicensePkgs)
			.map(({ name, licenses }) =>
				licenses
					.map(({ license, repos }) => ({
						license,
						repos: repos.map(
							({ repo, version }) =>
								`[\`\`\`${repo}\`\`\`](${orgUrl}/${repo}) @ ${version}`,
						),
					}))
					.map(({ license, repos }, idx) =>
						idx < 1
							? `| \`\`\`${name}\`\`\` | ${license} | ${repos} |`
							: `| | ${license} | ${repos} |`,
					)
					.join("\n"),
			)
			.join("\n")}\n\n` +
		`Please remove these dependencies.`;

	const generateSlackMdFromPkgs = (pkgsCategory: "blacklisted" | "missing") =>
		`Dependencies with ${pkgsCategory} licenses:\n\n` +
		`${(pkgsCategory === "blacklisted" ? blacklistPkgs : noLicensePkgs)
			.map(({ name, licenses }) =>
				licenses
					.map(({ license, repos }) => ({
						license,
						repos: repos.map(
							({ repo, version }) =>
								`\`${repo}\` (<${orgUrl}/${repo}|link>) @ ${version}`,
						),
					}))
					.map(({ license, repos }, idx) =>
						idx < 1 ? `*${name} - ${license}*\n - ${repos}` : `- ${repos}`,
					)
					.join("\n"),
			)
			.join("\n\n")}\n\n` +
		`Please remove these dependencies.`;

	const mdComponents = [
		"```license-scanner``` has detected dependency licensing issues:",
	];
	const slackMdComponents = ["*License Blacklist Scanner Results*"];

	if (blacklistPkgs.length > 0) {
		mdComponents.push(generateMDFromPkgs("blacklisted"));
		slackMdComponents.push(generateSlackMdFromPkgs("blacklisted"));
	}
	if (noLicensePkgs.length > 0) {
		mdComponents.push(generateMDFromPkgs("missing"));
		slackMdComponents.push(generateSlackMdFromPkgs("missing"));
	}

	const mdProblems = mdComponents.join("\n\n");
	const slackMdProblems = slackMdComponents.join("\n\n");

	console.log(mdProblems);

	if (slackWebhookUrl) {
		const url = new URL(slackWebhookUrl);
		fetch(url, {
			method: "POST",
			body: JSON.stringify({
				text: slackMdProblems,
			}),
		});
	}
};

run();

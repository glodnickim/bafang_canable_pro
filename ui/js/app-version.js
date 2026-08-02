// app-version.js — CB-021: show which build of the app is running.
//
// ui/version.json is written by scripts/bump-version.js at package time and shipped as an
// asset, so the number in the corner is the number of the binary you launched. Running from
// source (npm run dev) has no such file; that is reported as "dev" rather than left blank,
// because an empty badge reads as "no version" instead of "not a packaged build".
const badge = document.getElementById('appVersionBadge');
if (badge) {
    fetch('./version.json', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
            badge.textContent = data?.version ? `v${data.version}` : 'dev';
            if (data?.built) badge.title = `Application build v${data.version}, packaged ${data.built.slice(0, 16).replace('T', ' ')}. Firmware version is in the eVistDrive System tab.`;
        })
        .catch(() => { badge.textContent = 'dev'; });
}

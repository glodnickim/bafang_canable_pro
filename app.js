// app.js — entry point used when the application is packaged into a single
// executable with @yao-pkg/pkg. Running from source is unaffected: `npm run dev`
// still starts server.js directly.
//
// Why this file has to exist at all:
//
// The `usb` module is a native addon. The operating system loader can only
// dlopen/LoadLibrary a REAL file on disk — it cannot reach inside the pkg
// snapshot that lives in the .exe. So a genuinely single-file build has to unpack
// that one binary before anything requires 'usb'.
//
// `usb` resolves its binary through node-gyp-build, which checks NODE_USB_PATH
// first (node_modules/usb/dist/usb/bindings.js). That is the hook used below: the
// prebuild for the current platform is copied to a temp folder laid out the way
// node-gyp-build expects, and NODE_USB_PATH is pointed at it.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const UNPACK_DIR_NAME = 'evistdrive-canable-native';

function findPrebuildDir(prebuildsRoot) {
    const target = `${process.platform}-${process.arch}`;
    const names = fs.readdirSync(prebuildsRoot);
    // Exact match first, then the combined names node-gyp-build also uses,
    // e.g. "darwin-x64+arm64".
    return names.find((name) => name === target)
        || names.find((name) => {
            const [platform, archs] = name.split('-');
            return platform === process.platform
                && (archs || '').split('+').includes(process.arch);
        })
        || null;
}

function unpackNativeUsb() {
    const prebuildsRoot = path.join(__dirname, 'node_modules', 'usb', 'prebuilds');
    const dirName = findPrebuildDir(prebuildsRoot);
    if (!dirName) {
        throw new Error(`no usb prebuild bundled for ${process.platform}-${process.arch}`);
    }

    const sourceDir = path.join(prebuildsRoot, dirName);
    const rootDir = path.join(os.tmpdir(), UNPACK_DIR_NAME);
    const targetDir = path.join(rootDir, 'prebuilds', dirName);
    fs.mkdirSync(targetDir, { recursive: true });

    for (const file of fs.readdirSync(sourceDir)) {
        const source = path.join(sourceDir, file);
        const target = path.join(targetDir, file);
        const data = fs.readFileSync(source);
        // Rewrite only when missing or a different size: a normal restart then costs
        // nothing, and a half-written file from a killed process gets replaced.
        let current = null;
        try { current = fs.statSync(target); } catch { /* not there yet */ }
        if (!current || current.size !== data.length) {
            fs.writeFileSync(target, data);
        }
    }

    // node-gyp-build appends "prebuilds/<platform-arch>" to whatever it is given.
    process.env.NODE_USB_PATH = rootDir;
}

if (process.pkg) {
    try {
        unpackNativeUsb();
    } catch (error) {
        console.error('Failed to unpack the USB driver binary:', error.message);
        console.error('The CAN adapter cannot be opened without it. Check that the ' +
            'temp folder is writable and not blocked by antivirus software.');
        process.exit(1);
    }
}

require('./server');

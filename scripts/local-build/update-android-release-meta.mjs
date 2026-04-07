#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const rootDir = process.cwd();
const versionTag = (process.argv[2] || '').trim();
const releaseDirArg = (process.argv[3] || '').trim();

if (!versionTag || !releaseDirArg) {
  console.error(
    'Usage: node scripts/local-build/update-android-release-meta.mjs <versionTag> <releaseDir>'
  );
  process.exit(1);
}

const releaseDir = path.resolve(rootDir, releaseDirArg);
if (!fs.existsSync(releaseDir)) {
  console.error(`Release directory not found: ${releaseDir}`);
  process.exit(1);
}

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
};

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const files = fs.readdirSync(releaseDir).filter((item) => item.endsWith('.apk'));
const pick = (pattern) => files.find((item) => pattern.test(item)) ?? null;

const arm64File = pick(/android-arm64\.apk$/i);
const x64File = pick(/android-x86_64\.apk$/i);
const universalFile = pick(/android-universal\.apk$/i);
const universalDebugFile = pick(/android-universal-debug\.apk$/i);
const preferredFile = universalFile ?? arm64File ?? x64File ?? universalDebugFile;

if (!preferredFile) {
  console.error(`No Android APK found in ${releaseDir}`);
  process.exit(1);
}

const shaCache = new Map();
const readSha = (fileName) => {
  if (!fileName) {
    return null;
  }
  if (shaCache.has(fileName)) {
    return shaCache.get(fileName);
  }
  const abs = path.join(releaseDir, fileName);
  if (!fs.existsSync(abs)) {
    return null;
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  shaCache.set(fileName, digest);
  return digest;
};

const androidPackages = {};
if (universalFile) {
  androidPackages.apk = {
    file: universalFile,
    sha256: readSha(universalFile)
  };
}
if (arm64File) {
  androidPackages.arm64 = {
    file: arm64File,
    sha256: readSha(arm64File)
  };
}
if (x64File) {
  androidPackages.x86_64 = {
    file: x64File,
    sha256: readSha(x64File)
  };
}
if (universalDebugFile) {
  androidPackages.debug = {
    file: universalDebugFile,
    sha256: readSha(universalDebugFile)
  };
}

const relReleaseDir = path.relative(rootDir, releaseDir).replace(/\\/g, '/');
const preferredSha = readSha(preferredFile) || 'N/A';
const preferredUrl = `https://raw.githubusercontent.com/biglinfei-wq/orbitterm-client/main/${relReleaseDir}/${preferredFile}`;

const applyPayload = (base = {}) => {
  const next = { ...base };
  next.version = typeof next.version === 'string' && next.version.trim() ? next.version : versionTag;
  next.date =
    typeof next.date === 'string' && next.date.trim()
      ? next.date
      : new Date().toISOString().slice(0, 10);
  next.androidPackage = preferredFile;
  next.androidSha256 = preferredSha;
  next.androidSha = preferredSha;
  next.androidDownloadUrl = preferredUrl;
  next.androidPackages = androidPackages;
  return next;
};

const latestPath = path.resolve(rootDir, 'releases/latest.json');
if (fs.existsSync(latestPath)) {
  writeJson(latestPath, applyPayload(readJson(latestPath) ?? {}));
  console.log(`Updated: ${latestPath}`);
} else {
  console.log('Skipped: releases/latest.json not found');
}

const releaseManifestPath = path.join(releaseDir, 'release-manifest.json');
if (fs.existsSync(releaseManifestPath)) {
  writeJson(releaseManifestPath, applyPayload(readJson(releaseManifestPath) ?? {}));
  console.log(`Updated: ${releaseManifestPath}`);
} else {
  writeJson(releaseManifestPath, applyPayload({ version: versionTag }));
  console.log(`Created: ${releaseManifestPath}`);
}

const websiteMetaPath = path.resolve(rootDir, 'website/public/release-meta.json');
if (fs.existsSync(websiteMetaPath)) {
  writeJson(websiteMetaPath, applyPayload(readJson(websiteMetaPath) ?? {}));
  console.log(`Updated: ${websiteMetaPath}`);
}

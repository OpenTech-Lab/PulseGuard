#!/bin/bash

# Usage: ./scripts/bump-version.sh [<version>] [--force] [--no-tag] [--no-push]
# Example: ./scripts/bump-version.sh 0.1.1
# Example: ./scripts/bump-version.sh v0.1.1
#
# Release helper for PulseGuard:
# - bumps package.json version
# - optionally syncs package-lock.json root version fields when the file exists
# - bumps src-tauri/Cargo.toml package version
# - bumps src-tauri/tauri.conf.json version
# - writes scripts/version/<version>.md release notes
# - commits the release files
# - creates git tag v<version>
# - pushes the current branch and tag

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PACKAGE_JSON="${PROJECT_ROOT}/package.json"
PACKAGE_LOCK="${PROJECT_ROOT}/package-lock.json"
CARGO_TOML="${PROJECT_ROOT}/src-tauri/Cargo.toml"
TAURI_CONF="${PROJECT_ROOT}/src-tauri/tauri.conf.json"
VERSION_DIR="${SCRIPT_DIR}/version"

INPUT_VERSION=""
FORCE=false
CREATE_TAG=true
PUSH_CHANGES=true

usage() {
  cat <<'EOF'
Usage: ./scripts/bump-version.sh [<version>] [--force] [--no-tag] [--no-push]

Arguments:
  <version>   Semantic version to release, with or without a leading "v"
              Example: 0.1.1 or v0.1.1

Options:
  --force     Allow releasing a version that is not greater than the latest tag/current version
  --no-tag    Skip creating the git tag
  --no-push   Skip pushing the branch and tag
  -h, --help  Show this help text

If no version is provided, the script bumps the patch version from the latest
known version across package.json, src-tauri/Cargo.toml, and existing v* git tags.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=true
      ;;
    --no-tag)
      CREATE_TAG=false
      ;;
    --no-push)
      PUSH_CHANGES=false
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Error: unknown option '$1'"
      usage
      exit 1
      ;;
    *)
      if [ -n "${INPUT_VERSION}" ]; then
        echo "Error: multiple versions provided"
        usage
        exit 1
      fi
      INPUT_VERSION="$1"
      ;;
  esac
  shift
done

for required_file in "${PACKAGE_JSON}" "${CARGO_TOML}" "${TAURI_CONF}"; do
  if [ ! -f "${required_file}" ]; then
    echo "Error: ${required_file} not found"
    exit 1
  fi
done

CURRENT_PACKAGE_VERSION="$(node -p "require('${PACKAGE_JSON}').version")"
CURRENT_TAURI_VERSION="$(node -p "require('${TAURI_CONF}').version")"
CURRENT_CARGO_VERSION="$(sed -nE 's/^version = \"([0-9]+\.[0-9]+\.[0-9]+)\"$/\1/p' "${CARGO_TOML}" | head -n1)"

semver_gt() {
  local IFS=.
  local a=($1) b=($2)
  for i in 0 1 2; do
    local av="${a[$i]:-0}" bv="${b[$i]:-0}"
    if (( av > bv )); then return 0; fi
    if (( av < bv )); then return 1; fi
  done
  return 1
}

normalize_version() {
  echo "${1#v}"
}

LATEST_VERSION="${CURRENT_PACKAGE_VERSION}"
for candidate in "${CURRENT_TAURI_VERSION}" "${CURRENT_CARGO_VERSION}"; do
  if [ -n "${candidate}" ] && semver_gt "${candidate}" "${LATEST_VERSION}"; then
    LATEST_VERSION="${candidate}"
  fi
done

LATEST_TAG_VERSION="$(git -C "${PROJECT_ROOT}" tag --list 'v[0-9]*.[0-9]*.[0-9]*' | sed 's/^v//' | sort -V | tail -n1)"
if [ -n "${LATEST_TAG_VERSION}" ] && semver_gt "${LATEST_TAG_VERSION}" "${LATEST_VERSION}"; then
  LATEST_VERSION="${LATEST_TAG_VERSION}"
fi

if [ -z "${INPUT_VERSION}" ]; then
  IFS='.' read -r latest_major latest_minor latest_patch <<< "${LATEST_VERSION}"
  VERSION_NAME="${latest_major}.${latest_minor}.$((latest_patch + 1))"
  echo "No version supplied. Auto bumping patch: ${LATEST_VERSION} -> ${VERSION_NAME}"
else
  VERSION_NAME="$(normalize_version "${INPUT_VERSION}")"
fi

if ! echo "${VERSION_NAME}" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must be in format x.y.z or v.x.y.z"
  exit 1
fi

if ! semver_gt "${VERSION_NAME}" "${LATEST_VERSION}" && [ "${FORCE}" != "true" ]; then
  echo "Error: ${VERSION_NAME} must be greater than latest version (${LATEST_VERSION})."
  echo "Use a higher version number or pass --force to override."
  exit 1
fi

TAG_NAME="v${VERSION_NAME}"

if git -C "${PROJECT_ROOT}" rev-parse "${TAG_NAME}" >/dev/null 2>&1; then
  echo "Error: tag ${TAG_NAME} already exists."
  exit 1
fi

echo "Updating PulseGuard release version to ${VERSION_NAME}..."

export PACKAGE_JSON PACKAGE_LOCK TAURI_CONF VERSION_NAME
node <<'NODE'
const fs = require("fs");

const packageJsonPath = process.env.PACKAGE_JSON;
const packageLockPath = process.env.PACKAGE_LOCK;
const tauriConfPath = process.env.TAURI_CONF;
const version = process.env.VERSION_NAME;

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
packageJson.version = version;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

if (fs.existsSync(packageLockPath)) {
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
  packageLock.version = version;
  if (packageLock.packages && packageLock.packages[""]) {
    packageLock.packages[""].version = version;
  }
  fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
}

const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
tauriConf.version = version;
fs.writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`);
NODE

TMP_CARGO="$(mktemp)"
sed -E "0,/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"$/s//version = \"${VERSION_NAME}\"/" "${CARGO_TOML}" > "${TMP_CARGO}"
mv "${TMP_CARGO}" "${CARGO_TOML}"

echo "✓ Updated ${PACKAGE_JSON}"
if [ -f "${PACKAGE_LOCK}" ]; then
  echo "✓ Updated ${PACKAGE_LOCK}"
fi
echo "✓ Updated ${CARGO_TOML}"
echo "✓ Updated ${TAURI_CONF}"

mkdir -p "${VERSION_DIR}"
VERSION_FILE="${VERSION_DIR}/${VERSION_NAME}.md"

LAST_TAG="$(git -C "${PROJECT_ROOT}" describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)"
if [ -n "${LAST_TAG}" ]; then
  CHANGELOG_ENTRIES="$(git -C "${PROJECT_ROOT}" log "${LAST_TAG}"..HEAD --pretty=format:'- %h %s' || true)"
else
  CHANGELOG_ENTRIES="$(git -C "${PROJECT_ROOT}" log --max-count=30 --pretty=format:'- %h %s' || true)"
fi

if [ -z "${CHANGELOG_ENTRIES}" ]; then
  CHANGELOG_ENTRIES="- No changes since the previous release."
fi

cat > "${VERSION_FILE}" <<EOF
# Release ${TAG_NAME}

- Date: $(date +%F)
- Version: ${VERSION_NAME}

## Changes

${CHANGELOG_ENTRIES}
EOF

find "${VERSION_DIR}" -maxdepth 1 -type f -name '*.md' ! -name "${VERSION_NAME}.md" -delete

echo "✓ Wrote ${VERSION_FILE}"

git -C "${PROJECT_ROOT}" add "${PACKAGE_JSON}" "${CARGO_TOML}" "${TAURI_CONF}"
if [ -f "${PACKAGE_LOCK}" ]; then
  git -C "${PROJECT_ROOT}" add "${PACKAGE_LOCK}"
fi
git -C "${PROJECT_ROOT}" add -A "${VERSION_DIR}"

COMMIT_MSG="chore(release): ${VERSION_NAME}"

if git -C "${PROJECT_ROOT}" diff --cached --quiet; then
  echo "No staged release changes to commit."
else
  git -C "${PROJECT_ROOT}" commit -m "${COMMIT_MSG}"
  echo "✓ Committed: ${COMMIT_MSG}"
fi

if [ "${CREATE_TAG}" = "true" ]; then
  git -C "${PROJECT_ROOT}" tag -a "${TAG_NAME}" -m "Release ${TAG_NAME}"
  echo "✓ Created tag: ${TAG_NAME}"
fi

if [ "${PUSH_CHANGES}" = "true" ]; then
  CURRENT_BRANCH="$(git -C "${PROJECT_ROOT}" branch --show-current)"
  if [ -z "${CURRENT_BRANCH}" ]; then
    echo "Error: could not determine current branch for push"
    exit 1
  fi

  git -C "${PROJECT_ROOT}" push origin "${CURRENT_BRANCH}"
  if [ "${CREATE_TAG}" = "true" ]; then
    git -C "${PROJECT_ROOT}" push origin "${TAG_NAME}"
  fi

  echo "✓ Pushed origin/${CURRENT_BRANCH}"
  if [ "${CREATE_TAG}" = "true" ]; then
    echo "✓ Pushed ${TAG_NAME}"
  fi
fi

echo
echo "Done! Version is now ${VERSION_NAME}"


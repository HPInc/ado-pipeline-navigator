#!/bin/bash

unset GITHUB_TOKEN

# Load nvm and use Node 20
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 20 2>/dev/null || echo "Warning: nvm not available or Node 20 not installed"

usage() {
  echo "Usage: $0 [-i] [-p] [-r] [-d]"
  echo "  -i    Install dependencies"
  echo "  -p    Create pre-release package"
  echo "  -r    Create release package (default)"
  echo "  -d    Build development version"
  exit 1
}

INSTALL=0
PRE_RELEASE=0
RELEASE=1
DEVELOPMENT=0

while getopts ":iprd" OPT; do
  case ${OPT} in
    i)
      INSTALL=1
      ;;
    p)
      PRE_RELEASE=1
      ;;
    r)
      RELEASE=1
      ;;
    d)
      DEVELOPMENT=1
      ;;
    *)
      usage
      ;;
  esac
done

if [ $INSTALL -eq 1 ]; then
  npm install -g @vscode/vsce
  npm install -g webpack-cli
  npm install -g webpack
  npm install -g prettier
fi

# Install dependencies
npm install
npm audit fix

# Build extension (webpack outputs to extension-bundle.js)
if [ $DEVELOPMENT -eq 1 ]; then
  npm run build:dev
  exit 0
else
  npm run build:prod
fi

rm -f ./*.vsix

if [ $RELEASE -eq 1 ]; then
  if [ $PRE_RELEASE -eq 1 ]; then
    vsce package --pre-release
  else
    vsce package
  fi
fi

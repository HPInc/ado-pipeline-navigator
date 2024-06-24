#!/bin/bash

unset GITHUB_TOKEN

INSTALL=0
RELEASE=0

while getopts ":ir" OPT; do
  case ${OPT} in
    i)
      INSTALL=1
      ;;
    r)
      RELEASE=1
      ;;
    *)
      usage
      ;;
  esac
done

if [ $INSTALL -eq 1 ]; then
  npm install -g @vscode/vsce
  npm install -g webpack-cli
fi

npm install --production
npm run compile
npx webpack --mode production

rm -f *.vsix

VERSION=$(jq -Mr .version package.json)
if [ $RELEASE -eq 1 ]; then
  vsce package --pre-release
  #scp "ado-pipeline-navigator-${VERSION}.vsix" tools:/var/www/html/files/ado-pipeline-navigator.vsix
  #code --install-extension "ado-pipeline-navigator-${VERSION}.vsix"
  #vsce publish --pre-release
else
  vsce package
  #vsce publish
fi

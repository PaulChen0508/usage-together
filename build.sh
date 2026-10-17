#!/bin/sh
set -eu
APP_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DEST=${1:?Usage: build.sh /absolute/output/Usage\ Together.app /absolute/path/to/node}
APP_NODE=${2:?Supply a macOS Node.js runtime}
mkdir -p "$(dirname -- "$APP_DEST")"
APP_STAGE_ROOT=$(mktemp -d -t usage-together-build)
APP_STAGE="$APP_STAGE_ROOT/Usage Together.app"
/usr/bin/osacompile -s -l JavaScript -o "$APP_STAGE" "$APP_SOURCE/native.js"
mkdir -p "$APP_STAGE/Contents/Resources/runtime"
cp "$APP_SOURCE/backend.js" "$APP_SOURCE/native.js" "$APP_SOURCE/index.html" "$APP_SOURCE/ui.js" "$APP_SOURCE/style.css" "$APP_STAGE/Contents/Resources/"
cp "$APP_NODE" "$APP_STAGE/Contents/Resources/runtime/node"
cp "$APP_SOURCE/Node-LICENSE.txt" "$APP_STAGE/Contents/Resources/runtime/LICENSE.txt"
cp "$APP_SOURCE/AppIcon.icns" "$APP_STAGE/Contents/Resources/"
chmod 755 "$APP_STAGE/Contents/Resources/runtime/node"
cat > "$APP_STAGE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleSignature</key><string>aplt</string>
<key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
<key>CFBundleExecutable</key><string>applet</string>
<key>CFBundleIdentifier</key><string>local.usagetogether.mac.v201</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleName</key><string>Usage Together</string>
<key>CFBundleDisplayName</key><string>用量伴侣</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>2.3.7</string>
<key>CFBundleVersion</key><string>14</string>
<key>OSAAppletStayOpen</key><true/>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

/usr/bin/codesign --force --sign - "$APP_STAGE"

"$APP_STAGE/Contents/Resources/runtime/node" --version
if [ -e "$APP_DEST" ]; then
  APP_BACKUP_ROOT=$(mktemp -d -t usage-together-backup)
  mv "$APP_DEST" "$APP_BACKUP_ROOT/previous.app"
fi
mv "$APP_STAGE" "$APP_DEST"

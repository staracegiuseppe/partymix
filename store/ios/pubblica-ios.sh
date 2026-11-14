#!/bin/sh
# Builds PartyMix for the App Store and, if an App Store Connect API key is set, uploads it to TestFlight.
#
# Needed once (see store/ios/README.md):
#   - Apple Developer Program membership and Xcode signed in with that Apple ID (Xcode › Impostazioni › Account)
#   - APPLE_DEVELOPMENT_TEAM: the 10-character Team ID (developer.apple.com › Account › Membership)
# Optional, for the upload from here (otherwise drag the .ipa into the Transporter app):
#   - ASC_KEY_ID and ASC_ISSUER_ID, with the key file in ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8
set -eu
cd "$(dirname "$0")/../.."

: "${APPLE_DEVELOPMENT_TEAM:?imposta APPLE_DEVELOPMENT_TEAM con il Team ID di Apple}"
export APPLE_DEVELOPMENT_TEAM

# every upload needs a higher build number: year-month-day-hour-minute always grows
BUILD=$(date +%y%m%d%H%M)
echo "PartyMix iOS, build $BUILD"

npx tauri ios build --export-method app-store-connect --build-number "$BUILD"

IPA=$(find src-tauri/gen/apple/build -name '*.ipa' -newer package.json -print | head -1)
[ -n "$IPA" ] || { echo "Nessun .ipa trovato"; exit 1; }
echo "Pacchetto pronto: $IPA"

if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
  xcrun altool --upload-app --type ios --file "$IPA" --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  echo "Caricato: tra qualche minuto compare in App Store Connect › TestFlight."
else
  echo "Per caricarlo: apri l'app Transporter, accedi con il tuo Apple ID e trascina dentro il file .ipa."
fi

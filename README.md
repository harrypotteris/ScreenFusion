# ScreenFusion

AI-powered distributed multi-phone display system — CSL7460, Mobile and Pervasive Computing, IIT Jodhpur.

Multiple phones on the same Wi-Fi join one session, stream live sensor data to a central server, and (in later stages) display tiles of a single video as one synchronized screen.

## Status

- Done: networking and device connection, host/viewer sessions, sensor streaming (heading, tilt, battery, Wi-Fi RSSI), live device table
- Next: video playback with manual tiling and sync, then LLM-based arrangement inference

## Structure

```
server.js, src/, public/   Node.js + Express + ws central server
screenfusion-client/       Expo (React Native) mobile client
```

## Run the server

```
npm install
npm start
```

It prints the laptop's LAN IP. The browser test page is at `http://<ip>:4000/test.html`.

## Run the mobile client

Wi-Fi RSSI needs a native module, so Expo Go will not work — use a custom dev client.

```
cd screenfusion-client
npm install
eas build --profile development --platform android   # one time, install the resulting .apk
npx expo start --dev-client
```

In the app, enter `<server-ip>:4000`, then Create Session (host) or Join Session with the code.

## Notes

- Laptop and all phones must be on the same Wi-Fi or hotspot. The server IP can change between sessions, so check the terminal each time.
- RSSI is signal strength to the router (Android only), shown as a rough distance estimate. It is not phone-to-phone distance.

## Stack

Node.js, Express, ws, qrcode, uuid, Expo (React Native), expo-sensors, expo-battery, react-native-wifi-reborn, EAS Build.

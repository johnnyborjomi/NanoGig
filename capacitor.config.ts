import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shells (iOS first) around the same web app. Bluetooth goes through the
 * @capacitor-community/bluetooth-le plugin instead of Web Bluetooth, which iOS
 * web views do not have. See src/transport/ble-capacitor.ts.
 */
const config: CapacitorConfig = {
  appId: 'com.johnnyborjomi.nanogig',
  appName: 'NanoGig',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
    backgroundColor: '#07090c',
    preferredContentMode: 'mobile',
  },
  plugins: {
    StatusBar: { style: 'DARK', overlaysWebView: true },
  },
};

export default config;

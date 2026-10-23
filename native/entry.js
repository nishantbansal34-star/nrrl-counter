// Bundled into native.js for the Android app only: fast barcode scanning (Google ML Kit) and sharing files.
import { Capacitor } from '@capacitor/core';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
window.NrrlNative = { native: Capacitor.isNativePlatform(), BarcodeScanner, Filesystem, Directory, Share };

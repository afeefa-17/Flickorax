/**
 * Security test suite specification verifying all 12 Dirty Dozen payloads
 * against Flickorax Firestore Security Rules.
 */
export const DIRTY_DOZEN_CASES = [
  { id: 1, name: 'Anonymous Guest Watchlist Write', expected: 'PERMISSION_DENIED' },
  { id: 2, name: 'Anonymous Guest Preferences Write', expected: 'PERMISSION_DENIED' },
  { id: 3, name: 'Cross-User Watchlist Read/Write', expected: 'PERMISSION_DENIED' },
  { id: 4, name: 'Shadow Field Injection on Preferences', expected: 'PERMISSION_DENIED' },
  { id: 5, name: 'Non-Member Room Read', expected: 'PERMISSION_DENIED' },
  { id: 6, name: 'Room List Scraping', expected: 'PERMISSION_DENIED' },
  { id: 7, name: '11th Member Join Race', expected: 'PERMISSION_DENIED' },
  { id: 8, name: 'Non-Host Triggering Match', expected: 'PERMISSION_DENIED' },
  { id: 9, name: 'Spoofed Host Creation', expected: 'PERMISSION_DENIED' },
  { id: 10, name: 'Expired Room Join', expected: 'PERMISSION_DENIED' },
  { id: 11, name: 'Member Editing Picks After Match Starts', expected: 'PERMISSION_DENIED' },
  { id: 12, name: 'Client Timestamp Forgery / ID Poisoning', expected: 'PERMISSION_DENIED' },
] as const;

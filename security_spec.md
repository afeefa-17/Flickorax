# Flickorax Firestore Security Specification

## 1. Data Invariants
1. **Account Separation**: Anonymous guest sessions (`sign_in_provider == 'anonymous'`) can participate in Watch Party rooms, but can NEVER read or write `users/{userId}/preferences/*` or `users/{userId}/watchlist/*`.
2. **Owner-Only User Data**: Only the authenticated non-anonymous owner (`request.auth.uid == userId`) can read, list, create, update, or delete their own preferences and watchlist items.
3. **Strict Room Membership Read Isolation**: Only UIDs present in `rooms/{roomId}.memberIds` may read `rooms/{roomId}` or `rooms/{roomId}/members/*`. Listing `/rooms` or `/roomDirectory` is completely disabled (`allow list: if false`) to prevent scraping active room codes.
4. **Atomic 10-Member Cap**: Joining a room updates `rooms/{roomId}` (`memberIds`, `memberCount`, `updatedAt`), `roomDirectory/{roomId}` (`memberCount`, `updatedAt`), and creates `rooms/{roomId}/members/{uid}` in one atomic batch (`existsAfter`/`getAfter`). Rules verify `existing().memberIds.size() < 10` and `existing().memberCount < 10` at commit time, preventing concurrent callers from taking the 10th spot twice.
5. **Host-Only Match Execution**: Only `existing().hostId == request.auth.uid` can update `status` (`waiting` -> `matching` -> `matched` or `matched` -> `matching`) and `results` on `rooms/{roomId}`.
6. **15-Hour Room Expiry**: All joins, member preference updates, and host matches require `expiresAt > request.time`. Expired rooms (`expiresAt <= request.time`) can be deleted automatically to clean up room data.
7. **Immutable Fields & Strict Keys**: `createdAt`, `expiresAt`, `hostId`, `code`, `userId`, `addedAt`, and `joinedAt` are immutable after creation; `createdAt`/`updatedAt`/`addedAt`/`joinedAt` must equal `request.time`.

## 2. Adversarial "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Anonymous Guest Watchlist Write**: Anonymous user attempts `setDoc('/users/anon1/watchlist/tmdb-movie-1', ...)` -> DENIED (`isFullAccount()` fails).
2. **Anonymous Guest Preferences Write**: Anonymous user attempts `setDoc('/users/anon1/preferences/saved', ...)` -> DENIED (`isFullAccount()` fails).
3. **Cross-User Watchlist Read/Write**: User A attempts `getDoc` or `setDoc` on `/users/userB/watchlist/item1` -> DENIED (`request.auth.uid == userId` fails).
4. **Shadow Field Injection on Preferences**: User A submits `saved` preferences with extra field `type: "anime"` or `isAdmin: true` -> DENIED (`hasOnly` rejects).
5. **Non-Member Room Read**: User C (not in `memberIds`) attempts `getDoc('/rooms/K7P2XM')` -> DENIED (`request.auth.uid in existing().memberIds` fails).
6. **Room List Scraping**: Any user attempts `getDocs(collection(db, 'rooms'))` -> DENIED (`allow list: if false`).
7. **11th Member Join Race**: Room already has 10 members (`memberIds.size() == 10`); 11th user attempts join batch -> DENIED (`existing().memberIds.size() < 10` fails).
8. **Non-Host Triggering Match**: Member B (not `hostId`) attempts `updateDoc('/rooms/K7P2XM', { status: 'matched', results: [...] })` -> DENIED (`existing().hostId == request.auth.uid` fails).
9. **Spoofed Host Creation**: User A attempts to create a room with `hostId: 'otherUser'` -> DENIED (`incoming().hostId == request.auth.uid` fails).
10. **Expired Room Join**: Room `expiresAt` is in the past; user attempts join batch -> DENIED (`existing().expiresAt > request.time` fails).
11. **Member Editing Picks During/After Match**: Room `status` is `'matching'` or `'matched'`; member attempts to update `/rooms/K7P2XM/members/{uid}` -> DENIED (`room.status == 'waiting'` fails).
12. **Client Timestamp Forgery / ID Poisoning**: Attacker creates room with `code: 'BAD_1500_CHAR_ID'` or `createdAt` in 2030 -> DENIED (`isValidRoomCode` & `incoming().createdAt == request.time` fail).

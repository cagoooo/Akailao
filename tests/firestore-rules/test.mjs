// class-4719f 共用資料庫規則的模擬測試（剛好學＋班級小管家共用同一份 firestore.rules）。
// 只連本機的模擬資料庫，不碰正式資料。執行方式：
//   cd tests/firestore-rules
//   npm install          （第一次才需要；需要 Java 與 firebase-tools）
//   npm test
// 連接埠用 8181／4411／4511，避開其他工作階段可能正在用的 8080。
//
// 改規則的流程（兩個網站共用，正本在這個 repo）：
//   改 firestore.rules → 跑這支測試 → 在這個 repo 部署規則 → 複製到 H:\Class\firestore.rules，兩邊內容要完全相同。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
    doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp, query, where, limit,
} from 'firebase/firestore';

const APP = 'akailao-test';
const RESERVED_EMAIL = 'reserved-owner@example.test';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// 保留代碼在規則裡存的是真實信箱的雜湊，測試不知道也不該知道那個信箱：
// 把雜湊換成測試信箱的，其餘規則一字不改，測的是同一套判斷。
const REAL_HASH = /'[0-9a-f]{64}'/g;
// 想拿別的版本的規則來比較時（例如確認舊規則真的會被抓到）：RULES_FILE=<路徑> npm test
const source = readFileSync(process.env.RULES_FILE || new URL('../../firestore.rules', import.meta.url), 'utf8');
assert.ok(source.match(REAL_HASH)?.length >= 1, '規則裡找不到保留代碼的雜湊，測試要跟著調整');
const rules = source.replace(REAL_HASH, `'${sha256(RESERVED_EMAIL)}'`);

const env = await initializeTestEnvironment({
    projectId: 'demo-rules-test',
    firestore: { rules, host: '127.0.0.1', port: 8181 },
});

const google = (uid, extra = {}) => env.authenticatedContext(uid, {
    email: `${uid}@example.test`, email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...extra,
}).firestore();
const anon = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const guest = () => env.unauthenticatedContext().firestore();

const room = (db, code, ...rest) => doc(db, 'artifacts', APP, 'public', 'data', 'classrooms', code, ...rest);
const roomCol = (db, code, sub) => collection(db, 'artifacts', APP, 'public', 'data', 'classrooms', code, sub);
const claim = (db, code, ...rest) => doc(db, 'artifacts', APP, 'public', 'data', 'classroomClaims', code, ...rest);
const claimFields = (uid, name = '王老師') => ({ ownerUid: uid, ownerName: name, claimedAt: serverTimestamp(), lastUsedAt: serverTimestamp() });

async function seed() {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        const now = new Date();
        // 兩間教室：A100 有主人（owner1）、OLD9 是還沒有人申請的舊教室
        await setDoc(claim(db, 'A100'), { ownerUid: 'owner1', ownerName: '王老師', claimedAt: now, lastUsedAt: now });
        await setDoc(claim(db, 'A100', 'invite', 'current'), { code: 'ABCD2345', createdAt: now });
        await setDoc(claim(db, 'A100', 'members', 'co1'), { ownerUid: 'owner1', joinCode: 'ABCD2345', name: '協同', joinedAt: now });
        for (const code of ['A100', 'OLD9']) {
            await setDoc(room(db, code), { createdAt: now });
            await setDoc(room(db, code, 'settings', 'control'), { teacherId: 'owner1' });
            await setDoc(room(db, code, 'studentResponses', '學生甲'), { answer: 'A' });
            await setDoc(room(db, code, 'presence', 's1'), { at: now });
        }
        await setDoc(doc(db, 'artifacts', APP, 'public', 'data', 'sharedBanks', 'b1'), { name: '共享題庫' });
        // 班級小管家的資料
        await setDoc(doc(db, 'users', 'owner1', 'classes', 'c1'), { name: '五年一班' });
        await setDoc(doc(db, 'petShares', 'share-abcdefghijklmnopqrstu'), { ownerUid: 'owner1', classId: 'c1', className: '五年一班', nameMode: 'masked', showCoins: false, schema: 1, payload: '{}', updatedAt: now });
        await setDoc(doc(db, 'rateLimits', 'user_owner1_2026-11-24'), { count: 1 });
        await setDoc(doc(db, '_usageEvents', 'e1'), { type: 'login' });
    });
}

let passed = 0;
async function test(name, fn) {
    await seed();
    await fn();
    console.log('PASS', name);
    passed++;
}

// ───────── 2026-11-24 收緊的部分 ─────────

await test('不能把全部教室列出來（任何身分都不行）；用代碼查單一間仍然可以', async () => {
    const all = (db) => getDocs(collection(db, 'artifacts', APP, 'public', 'data', 'classrooms'));
    await assertFails(all(anon('s1')));
    await assertFails(all(google('owner1')));
    await assertFails(all(google('stranger')));
    await assertFails(getDocs(query(collection(anon('s1'), 'artifacts', APP, 'public', 'data', 'classrooms'), limit(1))));
    await assertSucceeds(getDoc(room(anon('s1'), 'A100')));
    await assertSucceeds(getDoc(room(google('owner1'), 'A100')));
    const missing = await assertSucceeds(getDoc(room(anon('s1'), 'NOPE')));
    assert.equal(missing.exists(), false, '查不存在的代碼不報錯（學生打錯代碼的提示靠這個）');
});

await test('不能把全部教室代碼的申請紀錄列出來；用代碼查單一筆仍然可以', async () => {
    const all = (db) => getDocs(collection(db, 'artifacts', APP, 'public', 'data', 'classroomClaims'));
    await assertFails(all(anon('s1')));
    await assertFails(all(google('owner1')));
    await assertFails(getDocs(query(collection(google('owner1'), 'artifacts', APP, 'public', 'data', 'classroomClaims'), where('ownerUid', '==', 'owner1'))));
    await assertSucceeds(getDoc(claim(anon('s1'), 'A100')));
    await assertSucceeds(getDoc(claim(google('stranger'), 'A100')));
    await assertSucceeds(getDoc(claim(google('stranger'), 'NOPE')));
});

await test('保留代碼：只有信箱驗證過的指定帳號能申請', async () => {
    const mine = { email: RESERVED_EMAIL };
    // 信箱文字對了，但沒有驗證過（或沒有這個欄位）：擋下
    await assertFails(setDoc(claim(google('r1', { ...mine, email_verified: false }), '601'), claimFields('r1')));
    const noFlag = env.authenticatedContext('r2', { email: RESERVED_EMAIL, firebase: { sign_in_provider: 'google.com' } }).firestore();
    await assertFails(setDoc(claim(noFlag, '601'), claimFields('r2')));
    // 別人的信箱：擋下
    await assertFails(setDoc(claim(google('stranger'), '601'), claimFields('stranger')));
    // 驗證過的指定帳號：可以；信箱大小寫不同也算同一個
    await assertSucceeds(setDoc(claim(google('r3', mine), '601'), claimFields('r3')));
    await assertSucceeds(setDoc(claim(google('r4', { email: RESERVED_EMAIL.toUpperCase() }), '602'), claimFields('r4')));
    // 不是保留代碼的照舊誰先申請誰用（不看信箱有沒有驗證）
    await assertSucceeds(setDoc(claim(google('t9', { email_verified: false }), 'FREE1'), claimFields('t9')));
});

// ───────── 既有行為不能被這次修改弄壞 ─────────

await test('學生（匿名）進教室：讀設定、整批讀同學的作答與出席、交自己的作答', async () => {
    const s = anon('s1');
    await assertSucceeds(getDoc(room(s, 'A100', 'settings', 'control')));
    await assertSucceeds(getDocs(roomCol(s, 'A100', 'studentResponses')));
    await assertSucceeds(getDocs(roomCol(s, 'A100', 'presence')));
    await assertSucceeds(getDocs(query(roomCol(s, 'A100', 'presence'), limit(5))));
    await assertSucceeds(setDoc(room(s, 'A100', 'studentResponses', '學生乙'), { answer: 'B' }));
    await assertSucceeds(setDoc(room(s, 'A100', 'presence', 's1'), { at: 1 }));
    await assertSucceeds(deleteDoc(room(s, 'A100', 'studentResponses', '學生乙')));
    await assertSucceeds(setDoc(room(s, 'A100', 'errors', 'e1'), { message: 'x' }));
});

await test('學生不能改教室設定、不能改教室本身、不能申請代碼', async () => {
    const s = anon('s1');
    await assertFails(setDoc(room(s, 'A100', 'settings', 'control'), { teacherId: 's1' }));
    await assertFails(setDoc(room(s, 'A100'), { hacked: true }));
    await assertFails(deleteDoc(room(s, 'A100')));
    await assertFails(setDoc(claim(s, 'NEW1'), claimFields('s1')));
    await assertFails(getDoc(claim(s, 'A100', 'invite', 'current')));
});

await test('教室的老師：主人與協同老師可以操作，別的老師不行', async () => {
    await assertSucceeds(setDoc(room(google('owner1'), 'A100', 'settings', 'control'), { teacherId: 'owner1' }));
    await assertSucceeds(setDoc(room(google('co1'), 'A100', 'settings', 'control'), { teacherId: 'owner1' }));
    await assertSucceeds(deleteDoc(room(google('owner1'), 'A100', 'studentResponses', '學生甲')));
    await assertFails(setDoc(room(google('stranger'), 'A100', 'settings', 'control'), { teacherId: 'stranger' }));
    await assertFails(deleteDoc(room(google('stranger'), 'A100', 'studentResponses', '學生甲')));
    // 別的老師仍然看得到教室（顯示「已經有人在用」需要）
    await assertSucceeds(getDoc(room(google('stranger'), 'A100', 'settings', 'control')));
    // 還沒有人申請的舊教室照舊開放給 Google 登入的老師
    await assertSucceeds(setDoc(room(google('stranger'), 'OLD9', 'settings', 'control'), { teacherId: 'stranger' }));
});

await test('教室代碼：先申請先用、主人更新使用時間、不能替別人申請、邀請碼只有主人看得到', async () => {
    await assertSucceeds(setDoc(claim(google('t2'), 'NEW1'), claimFields('t2')));
    await assertFails(setDoc(claim(google('t3'), 'NEW2'), claimFields('someone-else')));
    await assertSucceeds(updateDoc(claim(google('owner1'), 'A100'), { lastUsedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(claim(google('co1'), 'A100'), { lastUsedAt: serverTimestamp() }));
    await assertFails(updateDoc(claim(google('stranger'), 'A100'), { lastUsedAt: serverTimestamp() }));
    await assertFails(setDoc(claim(google('stranger'), 'A100'), claimFields('stranger')));
    await assertSucceeds(getDoc(claim(google('owner1'), 'A100', 'invite', 'current')));
    await assertFails(getDoc(claim(google('stranger'), 'A100', 'invite', 'current')));
    await assertSucceeds(getDocs(collection(google('owner1'), 'artifacts', APP, 'public', 'data', 'classroomClaims', 'A100', 'members')));
    // 用正確的邀請碼加入成為協同老師
    await assertSucceeds(setDoc(claim(google('t5'), 'A100', 'members', 't5'), { ownerUid: 'owner1', joinCode: 'ABCD2345', name: '新協同', joinedAt: serverTimestamp() }));
    await assertFails(setDoc(claim(google('t6'), 'A100', 'members', 't6'), { ownerUid: 'owner1', joinCode: 'WRONG999', name: 'x', joinedAt: serverTimestamp() }));
});

await test('主人超過 30 天沒用，別的老師可以接手（保留代碼除外）', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(claim(ctx.firestore(), 'STALE'), { ownerUid: 'gone', ownerName: '舊主人', claimedAt: old, lastUsedAt: old });
        await setDoc(claim(ctx.firestore(), '603'), { ownerUid: 'gone', ownerName: '舊主人', claimedAt: old, lastUsedAt: old });
    });
    await assertSucceeds(setDoc(claim(google('t7'), 'STALE'), claimFields('t7')));
    await assertFails(setDoc(claim(google('t8'), '603'), claimFields('t8')));
});

await test('共享題庫等其他公開資料照舊可以讀寫與列出', async () => {
    const banks = (db) => collection(db, 'artifacts', APP, 'public', 'data', 'sharedBanks');
    await assertSucceeds(getDocs(banks(google('t2'))));
    await assertSucceeds(setDoc(doc(google('t2'), 'artifacts', APP, 'public', 'data', 'sharedBanks', 'b2'), { name: '新題庫' }));
    await assertSucceeds(getDocs(banks(anon('s1'))));
});

await test('沒有登入的人：教室、代碼、老師資料都讀不到', async () => {
    const g = guest();
    await assertFails(getDoc(room(g, 'A100')));
    await assertFails(getDocs(roomCol(g, 'A100', 'studentResponses')));
    await assertFails(getDoc(claim(g, 'A100')));
    await assertFails(getDoc(doc(g, 'users', 'owner1', 'classes', 'c1')));
});

await test('班級小管家：老師只能讀寫自己的資料，彼此讀不到', async () => {
    await assertSucceeds(getDoc(doc(google('owner1'), 'users', 'owner1', 'classes', 'c1')));
    await assertSucceeds(getDocs(collection(google('owner1'), 'users', 'owner1', 'classes')));
    await assertSucceeds(setDoc(doc(google('owner1'), 'users', 'owner1', '_meta', 'classProfiles'), { list: [] }));
    await assertSucceeds(setDoc(doc(google('owner1'), 'users', 'owner1', 'classes', 'c1', 'syncSnapshots', 's1', 'parts', 'p0'), { text: 'x' }));
    await assertFails(getDoc(doc(google('stranger'), 'users', 'owner1', 'classes', 'c1')));
    await assertFails(setDoc(doc(google('stranger'), 'users', 'owner1', 'classes', 'c1'), { name: 'x' }));
    await assertFails(getDoc(doc(anon('s1'), 'users', 'owner1', 'classes', 'c1')));
});

await test('班級小管家：寵物分享連結免登入可讀單一份、不能列出、只有 Google 登入的本人能改', async () => {
    const id = 'share-abcdefghijklmnopqrstu';
    await assertSucceeds(getDoc(doc(guest(), 'petShares', id)));
    const missing = await assertSucceeds(getDoc(doc(guest(), 'petShares', 'not-exist-abcdefghijklmnop')));
    assert.equal(missing.exists(), false);
    await assertFails(getDocs(collection(guest(), 'petShares')));
    await assertFails(getDocs(collection(anon('s1'), 'petShares')));
    const fields = (uid) => ({ ownerUid: uid, classId: 'c1', className: '五年一班', nameMode: 'masked', showCoins: false, schema: 1, payload: '{}', updatedAt: serverTimestamp() });
    await assertSucceeds(setDoc(doc(google('owner1'), 'petShares', id), fields('owner1')));
    await assertSucceeds(setDoc(doc(google('t2'), 'petShares', 'share-zyxwvutsrqponmlkjihgf'), fields('t2')));
    await assertFails(setDoc(doc(google('stranger'), 'petShares', id), fields('stranger')));
    await assertFails(setDoc(doc(anon('s1'), 'petShares', 'share-anon-abcdefghijklmnop'), fields('s1')));
    await assertFails(deleteDoc(doc(google('stranger'), 'petShares', id)));
});

await test('後端專用的資料（使用紀錄、額度）前端一律碰不到；AI 次數只能讀自己的', async () => {
    await assertFails(getDoc(doc(google('owner1'), '_usageEvents', 'e1')));
    await assertFails(setDoc(doc(google('owner1'), '_usageRateLimits', 'x'), { total: 0 }));
    await assertFails(getDocs(collection(anon('s1'), '_usageEvents')));
    await assertSucceeds(getDoc(doc(google('owner1'), 'rateLimits', 'user_owner1_2026-11-24')));
    await assertFails(getDoc(doc(google('stranger'), 'rateLimits', 'user_owner1_2026-11-24')));
    await assertFails(setDoc(doc(google('owner1'), 'rateLimits', 'user_owner1_2026-11-24'), { count: 0 }));
});

await env.cleanup();
console.log(`${passed} 項規則測試全部通過`);

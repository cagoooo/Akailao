// 🆕 [V4.6.0] 教室代碼「先申請先用」
// 同一個代碼不分帳號都是同一間教室，所以代碼要有主人。資料結構與權限見 firestore.rules：
//   artifacts/{appId}/public/data/classroomClaims/{代碼}                主人與最後使用時間
//   artifacts/{appId}/public/data/classroomClaims/{代碼}/members/{uid}  協同老師
//   artifacts/{appId}/public/data/classroomClaims/{代碼}/invite/current 邀請碼（只有主人看得到）
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';

export const CLAIM_EXPIRE_DAYS = 30;
export const INVITE_EXPIRE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// 邀請碼字元：去掉容易看錯的 0 O 1 I L
const INVITE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 只顯示姓名的頭尾字，例如「王小明」→「王○明」 */
export function maskName(name) {
    const s = String(name || '').trim();
    if (!s) return '另一位老師';
    const chars = [...s];
    if (chars.length === 1) return chars[0] + '○';
    if (chars.length === 2) return chars[0] + '○';
    return chars[0] + '○'.repeat(Math.min(chars.length - 2, 3)) + chars[chars.length - 1];
}

/** 產生 8 碼邀請碼，顯示成 ABCD-2345 */
export function makeInviteCode() {
    const buf = new Uint32Array(8);
    crypto.getRandomValues(buf);
    let out = '';
    for (const n of buf) out += INVITE_CHARS[n % INVITE_CHARS.length];
    return out;
}
export function formatInviteCode(code) {
    const c = String(code || '');
    return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}
/** 老師輸入的邀請碼：去掉空白與連字號、轉大寫 */
export function normalizeInviteCode(input) {
    return String(input || '').toUpperCase().replace(/[\s\-－—]/g, '');
}

function toMillis(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    const n = Number(ts);
    return Number.isFinite(n) ? n : 0;
}

export function createClassroomClaims(db, appId) {
    const claimRef = (code) => doc(db, 'artifacts', appId, 'public', 'data', 'classroomClaims', code);
    const memberRef = (code, uid) => doc(db, 'artifacts', appId, 'public', 'data', 'classroomClaims', code, 'members', uid);
    const membersCol = (code) => collection(db, 'artifacts', appId, 'public', 'data', 'classroomClaims', code, 'members');
    const inviteRef = (code) => doc(db, 'artifacts', appId, 'public', 'data', 'classroomClaims', code, 'invite', 'current');

    const takenResult = (data) => ({
        ok: false,
        reason: 'taken',
        ownerName: data?.ownerName || '',
        lastUsedAt: toMillis(data?.lastUsedAt),
    });

    const newClaim = (user) => ({
        ownerUid: user.uid,
        ownerName: String(user.displayName || '').slice(0, 100),
        claimedAt: serverTimestamp(),
        lastUsedAt: serverTimestamp(),
    });

    async function touch(code) {
        try { await updateDoc(claimRef(code), { lastUsedAt: serverTimestamp() }); } catch (e) { /* 只是更新使用時間，失敗不影響進教室 */ }
    }

    async function isMemberOf(code, uid, ownerUid) {
        try {
            const m = await getDoc(memberRef(code, uid));
            return m.exists() && m.data().ownerUid === ownerUid;
        } catch (e) {
            return false;
        }
    }

    /**
     * 進教室前確認代碼歸屬。
     * 回傳 { ok:true, role:'owner'|'co'|'none'|'unknown' } 或 { ok:false, reason:'taken'|'reserved', ownerName, lastUsedAt }
     * 'unknown'：網路等原因查不到，先放行（資料庫規則仍會把關）。
     */
    async function ensure(code, user) {
        if (!user || user.isAnonymous) return { ok: true, role: 'none' };
        const ref = claimRef(code);
        let snap;
        try {
            snap = await getDoc(ref);
        } catch (e) {
            return { ok: true, role: 'unknown', error: e };
        }

        if (!snap.exists()) {
            try {
                await setDoc(ref, newClaim(user));
                return { ok: true, role: 'owner', created: true };
            } catch (e) {
                if (e?.code !== 'permission-denied') return { ok: true, role: 'unknown', error: e };
                // 被拒：可能剛好有人先申請，或這是保留代碼
                try {
                    const again = await getDoc(ref);
                    if (again.exists()) return again.data().ownerUid === user.uid ? { ok: true, role: 'owner' } : takenResult(again.data());
                } catch (_) { /* 照保留代碼處理 */ }
                return { ok: false, reason: 'reserved' };
            }
        }

        const data = snap.data();
        if (data.ownerUid === user.uid) {
            await touch(code);
            return { ok: true, role: 'owner' };
        }
        if (await isMemberOf(code, user.uid, data.ownerUid)) {
            await touch(code);
            return { ok: true, role: 'co', ownerName: data.ownerName || '' };
        }
        const last = toMillis(data.lastUsedAt);
        if (last && Date.now() - last > CLAIM_EXPIRE_DAYS * DAY_MS) {
            try {
                await setDoc(ref, newClaim(user));
                return { ok: true, role: 'owner', takeover: true };
            } catch (e) { /* 保留代碼或剛被別人接手 */ }
        }
        return takenResult(data);
    }

    /** 用邀請碼加入成為協同老師 */
    async function joinWithInvite(code, user, rawJoinCode) {
        const joinCode = normalizeInviteCode(rawJoinCode);
        if (!user || user.isAnonymous || joinCode.length !== 8) return { ok: false, reason: 'bad-code' };
        try {
            const snap = await getDoc(claimRef(code));
            if (!snap.exists()) return { ok: false, reason: 'bad-code' };
            await setDoc(memberRef(code, user.uid), {
                ownerUid: snap.data().ownerUid,
                joinCode,
                name: String(user.displayName || '').slice(0, 100),
                joinedAt: serverTimestamp(),
            });
            await touch(code);
            return { ok: true, role: 'co', ownerName: snap.data().ownerName || '' };
        } catch (e) {
            return { ok: false, reason: e?.code === 'permission-denied' ? 'bad-code' : 'error', error: e };
        }
    }

    /** 主人：產生新的邀請碼（舊的立即失效） */
    async function createInvite(code) {
        const inviteCode = makeInviteCode();
        await setDoc(inviteRef(code), { code: inviteCode, createdAt: serverTimestamp() });
        return inviteCode;
    }

    /** 主人：目前的協同老師 */
    async function listMembers(code) {
        const owner = await getDoc(claimRef(code));
        const ownerUid = owner.exists() ? owner.data().ownerUid : null;
        const snap = await getDocs(membersCol(code));
        return snap.docs
            .filter(d => d.data().ownerUid === ownerUid)
            .map(d => ({ uid: d.id, name: d.data().name || '', joinedAt: toMillis(d.data().joinedAt) }));
    }

    async function removeMember(code, uid) {
        await deleteDoc(memberRef(code, uid));
    }

    async function getRole(code, user) {
        if (!user || user.isAnonymous) return 'none';
        try {
            const snap = await getDoc(claimRef(code));
            if (!snap.exists()) return 'none';
            if (snap.data().ownerUid === user.uid) return 'owner';
            return (await isMemberOf(code, user.uid, snap.data().ownerUid)) ? 'co' : 'other';
        } catch (e) {
            return 'unknown';
        }
    }

    return { ensure, joinWithInvite, createInvite, listMembers, removeMember, getRole };
}

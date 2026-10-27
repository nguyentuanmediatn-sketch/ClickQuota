import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceURL = (name) =>
  pathToFileURL(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', name)).href;

function jwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${b}.sig`;
}

const cookieFor = (userId, email, team) =>
  `_ga=GA1.2.${userId}; cu_public=${jwt({ userId, email, default_team: team })}; cu_refresh=${jwt({ user: userId, workspace_id: team })}`;

test('Account isolation (no network, no state writes)', async (t) => {
  const { WorkspacePool } = await import(sourceURL('clickup-pool.mjs'));
  const newPool = () => {
    const p = new WorkspacePool();
    p.onPersist = null;
    p.workspaces = [];
    p.accounts = [];
    return p;
  };

  await t.test('two raw cookies with different user IDs become two distinct accounts', async () => {
    const pool = newPool();
    const a = await pool.addAccount({ cookie: cookieFor(1001, 'a@corp.vn', 8881) });
    const b = await pool.addAccount({ cookie: cookieFor(1002, 'b@corp.vn', 8882) });
    assert.equal(a.action, 'created');
    assert.equal(b.action, 'created');
    assert.equal(pool.accounts.length, 2);
    assert.notEqual(a.account.id, b.account.id);
    assert.equal(a.account.userId, 1001);
    assert.equal(b.account.userId, 1002);
    assert.equal(a.account.email, 'a@corp.vn');
    assert.equal(b.account.workspaceId, '8882');
    assert.ok(a.account.cuRefresh && a.account.cuRefresh !== b.account.cuRefresh);
  });

  await t.test('adding the same cookie twice updates instead of duplicating', async () => {
    const pool = newPool();
    const c = cookieFor(1001, 'a@corp.vn', 8881);
    const first = await pool.addAccount({ cookie: c });
    const again = await pool.addAccount({ cookie: c });
    assert.equal(first.action, 'created');
    assert.equal(again.action, 'updated');
    assert.equal(pool.accounts.length, 1);
  });

  await t.test('cookies without identity claims do not collide on the same millisecond', async () => {
    const pool = newPool();
    await pool.addAccount({ cookie: 'cu_refresh=rt-aaa' });
    await pool.addAccount({ cookie: 'cu_refresh=rt-bbb' });
    assert.equal(pool.accounts.length, 2);
    assert.notEqual(pool.accounts[0].id, pool.accounts[1].id);
  });

  await t.test('workspaces are matched to their own account by token user claim', () => {
    const pool = newPool();
    pool.initFromConfig({
      accounts: [
        { id: 'acc-1001', userId: 1001, cuRefresh: 'rt-1', enabled: true },
        { id: 'acc-1002', userId: 1002, cuRefresh: 'rt-2', enabled: true },
      ],
      workspaces: [
        { workspaceId: 'w1', token: jwt({ user: 1001 }) },
        { workspaceId: 'w2', token: jwt({ user: 1002 }) },
      ],
    });
    assert.equal(pool.workspaces[0].accountId, 'acc-1001');
    assert.equal(pool.workspaces[1].accountId, 'acc-1002');
  });

  await t.test('workspaceId and initialToken survive persist and init roundtrip', async () => {
    const pool = newPool();
    let saved = null;
    pool.onPersist = (state) => { saved = JSON.parse(JSON.stringify(state)); };
    await pool.addAccount({ cookie: cookieFor(1001, 'a@corp.vn', 8881), initialToken: 'tok-initial' });
    assert.ok(saved, 'persist phải được gọi');
    assert.equal(saved.accounts[0].workspaceId, '8881');
    assert.equal(saved.accounts[0].initialToken, 'tok-initial');

    const reloaded = newPool();
    reloaded.initFromConfig(saved);
    assert.equal(reloaded.accounts[0].workspaceId, '8881');
    assert.equal(reloaded.accounts[0].initialToken, 'tok-initial');
  });
});

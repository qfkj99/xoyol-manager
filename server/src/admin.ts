import readline from 'readline';
import { createInterface } from 'readline/promises';
import db from './database';
import { runMigrations } from './database/migrations';
import { userModel } from './models/User';
import { hashPassword, validateUsername } from './services/password';
import { revokeUserSessions } from './services/session';
import { recordAudit } from './services/audit';

async function hiddenInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('请在交互式终端中执行，密码不能通过命令行或管道传入');
  process.stdout.write(prompt);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onKey = (text: string | undefined, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('操作已取消'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { value = value.slice(0, -1); return; }
      if (!key.ctrl && !key.meta && text && !/[\r\n\x00-\x1f\x7f]/.test(text)) value += text;
    };
    process.stdin.on('keypress', onKey);
  });
}

async function main() {
  const command = process.argv[2];
  if (!['init', 'reset'].includes(command)) throw new Error('用法：npm run admin:init -- 用户名；或 npm run admin:reset -- 管理员用户名');
  let username = process.argv[3];
  if (!username) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    username = await input.question('管理员用户名：');
    input.close();
  }
  username = validateUsername(username);
  await runMigrations();
  if (command === 'init' && db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new Error('系统已初始化；请使用 admin:reset 恢复管理员密码');
  const password = await hiddenInput('新密码（12～128 位，输入隐藏）：');
  const confirm = await hiddenInput('再次输入密码：');
  if (password !== confirm) throw new Error('两次输入的密码不一致');
  const passwordHash = await hashPassword(password);
  db.transaction(() => {
    if (command === 'init') {
      if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new Error('系统已由其他进程初始化');
      const admin = userModel.create({ username, display_name: username, password_hash: passwordHash, role: 'admin', source: 'admin', must_change_password: false });
      db.prepare('UPDATE accounts SET owner_user_id=? WHERE owner_user_id IS NULL').run(admin.id);
      db.prepare('UPDATE tags SET owner_user_id=? WHERE owner_user_id IS NULL').run(admin.id);
      // Normalize historical defaults before assigning ownership under the new unique index.
      db.exec('UPDATE proxies SET is_default=0 WHERE owner_user_id IS NULL AND is_default=1 AND id<>(SELECT COALESCE(MAX(id),0) FROM proxies WHERE owner_user_id IS NULL AND is_default=1)');
      db.prepare('UPDATE proxies SET owner_user_id=? WHERE owner_user_id IS NULL').run(admin.id);
      recordAudit(admin.id, 'system.initialize', 'user', admin.id, 'local-cli');
    } else {
      const admin = userModel.getByUsername(username);
      if (!admin || admin.role !== 'admin' || admin.status !== 'active') throw new Error('找不到有效的管理员账号');
      db.prepare('UPDATE users SET password_hash=?,must_change_password=1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(passwordHash, admin.id);
      revokeUserSessions(admin.id);
      recordAudit(admin.id, 'user.recover_password', 'user', admin.id, 'local-cli');
    }
  }).immediate();
  process.stdout.write(command === 'init' ? '管理员已创建，历史数据已归属该管理员。\n' : '管理员密码已重置，全部会话已撤销。登录后请修改密码。\n');
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}).finally(() => { if (db.open) db.close(); });

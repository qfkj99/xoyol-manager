import db from '../database';

/** Only categorical metadata belongs here: never passwords, tokens or mail bodies. */
export function recordAudit(actorId: number | null, action: string, targetType = '', targetId: string | number = '', ip = '', result = 'success') {
  db.prepare('INSERT INTO audit_logs (actor_id,action,target_type,target_id,ip,result) VALUES (?,?,?,?,?,?)')
    .run(actorId, action, targetType, String(targetId), ip, result);
}

export const GAME_IMPORT_FORMAT = ['game_account', 'game_password', 'real_name', 'id_last_six', 'email', 'password', 'client_id', 'refresh_token'];
export const GAME_FIELD_LABELS: Record<string, string> = {
  game_account: '游戏账号', game_password: '游戏密码', real_name: 'name / 姓名', id_last_six: '身份证后六位',
  email: '绑定微软邮箱', password: '邮箱密码', client_id: 'client_id', refresh_token: '刷新令牌',
  share_link: '短链',
};
export const GAME_IMPORT_HINT = '游戏账号----游戏密码----name----身份证后六位----邮箱----邮箱密码----client_id----刷新令牌';
export const GAME_CLAIM_FORMAT = ['game_account', 'game_password', 'real_name', 'id_last_six', 'share_link'];
export const GAME_CLAIM_HINT = '游戏账号----游戏密码----name----身份证后六位----短链';

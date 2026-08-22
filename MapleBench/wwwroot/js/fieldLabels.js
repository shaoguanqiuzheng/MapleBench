/**
 * Front-end Chinese labels for WZ field keys.
 *
 * The backend field catalogs (Skill/Mob) ship English labels and the raw keys
 * are meaningless ("hs", "conMP", "lt"). This table maps the well-known keys to
 * the Chinese names of MapleStory's structure, so every editor reads one set of
 * names. An unknown key falls back to whatever label the caller already had
 * (usually the backend's English one), then to the bare key.
 *
 * Sources: the community structure notes for Skill.wz / Mob.wz / Character.wz /
 * Item.wz / Etc.wz / TamingMob.wz / Morph.wz / Quest.wz / Map.wz, merged with
 * the item catalog that was already localised on the server.
 */

export const FIELD_LABELS = {
  /* ---- Skill.wz ------------------------------------------------ */
  hs: '简介级别号', req: '前置技能等级', masterLevel: '技能上限', mob: '对怪物效果',
  skillType: '技能类型', disable: '禁止升级', invisible: '可见性', elemAttr: '攻击属性',
  action: '动作', prop: '发动几率', mastery: '熟练度', mobCount: '攻击数量',
  attackCount: '攻击次数', bulletCount: '子弹数', cooltime: '冷却时间', damage: '伤害%',
  range: '攻击距离', hpCon: 'HP消耗', mpCon: 'MP消耗', lt: '范围左上', rb: '范围右下',
  MaxLevel: '最高等级', Mastery: '熟练度', damR: '伤害增加', damL: '伤害减少',
  combatOrders: '战斗指令', criticaldamageMin: '最小暴击伤害', criticaldamageMax: '最大暴击伤害',
  cr: '暴击几率', x: '自定义值x', y: '自定义值y', z: '自定义值z', u: '自定义值u',
  v: '自定义值v', w: '自定义值w', padskill: '指定属性技能', finaAttack: '终极攻击',
  time: '持续时间', SelfDestruction: '爆炸攻击力', mhpR: 'HP上限增加', MmpR: 'MP上限增加',
  hp: '回复HP', mp: '回复MP', speed: '移动速度', jump: '跳跃力', asrR: '属性抗性',
  terR: '异常状态抵抗', pad: '攻击力增加', epad: '攻击力增加', padR: '攻击力增加%',
  pdd: '防御力增加', epdd: '防御力增加', pddR: '防御力增加%', mad: '魔法攻击增加',
  emad: '魔法攻击增加', madR: '魔法攻击增加%', mdd: '魔法防御增加', emdd: '魔法防御增加',
  mddR: '魔法防御增加%', acc: '命中率', accR: '命中率增加%', eva: '回避率', evaR: '回避率增加%',
  exp: '经验值', expR: '经验值增加%', ignoreMobpdpR: '无视怪物防御几率', itemCon: '消耗物品',
  itemConsume: '消耗品', itemConNo: '消耗数量', dot: '持续伤害', dottime: '持续伤害时间',
  dotInterval: '伤害间隔', bulletConsume: '子弹消耗', weapon: '武器限制', Subweapon: '副手限制',
  psd: '特殊属性', keydown: '按住动画', mdd2: '魔法防御2', mad2: '魔法攻击2',
  // animation nodes
  repeat: '重复播放', delay: '延迟', hitafter: '伤害延迟', origin: '贴图原点',
  prepare: '准备', effect: '主要效果', effect0: '附加效果', spcial: '特殊效果',
  ball: '远距贴图', filp: '附加远距贴图', hit: '受击贴图', tile: '密集贴图',
  afterimage: '攻击划痕', canvas: '图像', color: '颜色', alpha: '透明度',

  /* ---- Mob.wz --------------------------------------------------- */
  level: '等级', maxHP: '最大血值', maxMP: '最大魔值', PADamage: '物理攻击',
  PDDamage: '物理防御', MADamage: '魔法攻击', MDDamage: '魔法防御', expValue: '经验值',
  undead: '不死系', bodyAttack: '身体碰撞', fs: '常数值', attackAfter: '攻击效果时间',
  conMP: '耗费魔量', knockback: '击退', tremble: '屏幕震动', attack: '攻击',
  pushed: '打退', hpRecovery: 'HP恢复', mpRecovery: 'MP恢复', boss: 'Boss', hpTagColor: '血条颜色',
  removeAfter: '删除时间', info: '信息', link: '链接', linkTarget: '链接目标',

  /* ---- Character.wz (equipment) --------------------------------- */
  afterImage: '攻击的划痕', attackSpeed: '攻击速度', cash: '现金道具', incACC: '增加命中',
  incDEX: '增加敏捷', incINT: '增加智力', incLUK: '增加幸运', incSTR: '增加力量',
  incPAD: '增加物理攻击', incHP: '增加血值', incMP: '增加魔值', incMAD: '增加魔法攻击',
  incMDD: '增加魔法防御', incPDD: '增加物理防御', reqDEX: '需求敏捷', reqINT: '需求智力',
  reqJob: '需求职业', reqLevel: '需求等级', reqLUK: '需求幸运', reqSTR: '需求力量',
  reqPOP: '需求人气', tuc: '升级次数', knockbackRate: '击退几率', notSale: '无法出售',
  only: '固有道具', price: '出售价格', timeLimited: '时间限制', tradeBlock: '不可交易',
  equipTradeBlock: '装备后不可交易', weaponExp: '武器经验',
  incPADMax: '最大物理攻击+', incPADMin: '最小物理攻击+', incMADMax: '最大魔法攻击+',
  incMADMin: '最小魔法攻击+', incDEXMax: '最大敏捷+', incDEXMin: '最小敏捷+',
  incSTRMax: '最大力量+', incSTRMin: '最小力量+', incLUKMax: '最大幸运+',
  incLUKMin: '最小幸运+', incINTMax: '最大智力+', incINTMin: '最小智力+',
  incSPEED: '增加移动速度', incjump: '增加跳跃力', incMHP: '增加HP总值', incMMP: '增加MP总值',
  islot: '穿戴槽位', vslot: '可用槽位', icon: '图标', iconRaw: '原始图标', iconReward: '奖励图标',

  /* ---- Item.wz -------------------------------------------------- */
  slotMax: '最大堆叠', recoveryHP: '恢复HP', recoveryMP: '恢复MP', mcType: '消耗类型',
  consumeOnPickup: '拾起消耗', party: '组队恢复', hpR: 'HP恢复%', mpR: 'MP恢复%',
  berserk: '增加伤害%', booster: '减少攻击延迟', reward: '奖赏', count: '获得数量',
  item: '物品ID', prob: '几率(万分之)', moveTo: '到达地图', success: '成功率',
  PAD: '增加物理攻击', PDD: '增加物理防御', MAD: '增加魔法攻击', MDD: '增加魔法防御',
  peed: '增加移动速度', mesoupbyitem: '金钱暴率%', poison: '毒', darkness: '黑暗',
  weakness: '虚弱', seal: '封印', morph: '变身', quest: '任务道具', reqSkillLevel: '技能等级需求',
  dropBlock: '丢弃限制', max: '最大值', min: '最小值', unit: '单位', name: '名称', desc: '描述',

  /* ---- Etc.wz (crafting) ---------------------------------------- */
  catalyst: '催化剂', itemNum: '制造数量', meso: '需要的金钱', recipe: '所需材料',
  reqItem: '需求道具',

  /* ---- TamingMob.wz / Morph.wz ---------------------------------- */
  fatigue: '疲劳', swim: '游泳速度',

  /* ---- Quest.wz -------------------------------------------------- */
  nextQuest: '下一任务', money: '奖励金钱', npc: '所需NPC', job: '所需职业',
  end: '结束时间', start: '开始时间', interval: '重复间隔', normalAutoStart: '自动开始',

  /* ---- Map.wz ---------------------------------------------------- */
  bgm: '背景音乐', cloud: '云雾', fieldLimit: '地图限制', forcedReturn: '强制返回',
  hideMinimap: '隐藏小地图', mapMark: '地图标记', mobRate: '怪物比例', returnMap: '返回地图',
  town: '城镇', version: '版本', VRBottom: '地图底部', VRLeft: '地图左边', VRRight: '地图右边',
  VRTop: '地图顶边', next: '下一地板', prev: '上一地板', x1: '地板左X', x2: '地板右X',
  y1: '地板上Y', y2: '地板下Y', decHP: '扣除HP', protectItem: '保护物品', recovery: '恢复HP倍数',
  effect: '地图效果', bS: '地图目录', ToolTip: '提示文本', User: '进入者',
};

/** Chinese names for the Character.wz part directories (equipment filter). */
export const PART_LABELS = {
  Accessory: '饰品', Cap: '帽子', Cape: '披风', Coat: '上衣', Dragon: '龙装备',
  Glove: '手套', Longcoat: '长袍', Pants: '裤子', PetEquip: '宠物装备',
  Ring: '戒指', Shield: '盾牌', Shoes: '鞋子', TamingMob: '骑宠', Weapon: '武器',
};

/** Resolve a key to its Chinese label, falling back to the given label, then the key. */
export const fieldLabel = (key, fallback) => FIELD_LABELS[key] ?? fallback ?? key;

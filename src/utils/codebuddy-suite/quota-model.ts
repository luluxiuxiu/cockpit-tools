/**
 * CodeBuddy Suite 配额模型函数
 *
 * 用于计算和展示配额信息的统一函数
 */

import {
  PACKAGE_CODE,
  RESOURCE_STATUS,
  ENTERPRISE_ACCOUNT_TYPES,
} from '../../types/codebuddy-suite';
import type {
  CodebuddySuiteAccountBase,
  CodebuddyPlanDetail,
  OfficialQuotaResource,
  OfficialQuotaModel,
  CodebuddyUsage,
  QuotaDisplayItem,
  QuotaCategoryGroup,
} from '../../types/codebuddy-suite';
import {
  asRecord,
  parseNumeric,
  parseDateTimeToEpoch,
  parseCycleTotal,
  parseCycleRemain,
  isActiveResource,
  isExtraPackage,
  isBonusPackage,
  isTrialOrFreeMonPackage,
  isProPackage,
  resolvePlanTierFromPackageCode,
  extractResourceAccounts,
  getAccountQuotaUpdatedAtMs,
  aggregateCycleResources,
} from './parser';

/**
 * 将原始资源转换为 OfficialQuotaResource
 */
export function toOfficialQuotaResource(raw: Record<string, unknown>): OfficialQuotaResource {
  const packageCode = typeof raw.PackageCode === 'string' ? raw.PackageCode : null;
  const packageName = typeof raw.PackageName === 'string' ? raw.PackageName : null;
  const cycleStartTime = typeof raw.CycleStartTime === 'string' ? raw.CycleStartTime : null;
  const cycleEndTime = typeof raw.CycleEndTime === 'string' ? raw.CycleEndTime : null;
  const deductionEndTime = parseNumeric(raw.DeductionEndTime);
  const expiredTime = typeof raw.ExpiredTime === 'string' ? raw.ExpiredTime : null;

  const total = parseCycleTotal(raw);
  const remain = parseCycleRemain(raw);
  const used = Math.max(0, total - remain);
  const usedPercent = total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;
  const remainPercent = total > 0 ? Math.max(0, Math.min(100, (remain / total) * 100)) : null;

  const cycleEndAt = parseDateTimeToEpoch(cycleEndTime);
  const expireAt = deductionEndTime ?? parseDateTimeToEpoch(expiredTime) ?? cycleEndAt;
  const refreshAt = cycleEndAt != null && expireAt != null && cycleEndAt !== expireAt ? cycleEndAt + 1000 : null;

  const isBasePackage = packageCode === PACKAGE_CODE.free || packageCode === PACKAGE_CODE.freeMon;

  return {
    packageCode,
    packageName,
    cycleStartTime,
    cycleEndTime,
    deductionEndTime,
    expiredTime,
    total,
    remain,
    used,
    usedPercent,
    remainPercent,
    refreshAt,
    expireAt,
    isBasePackage,
  };
}

/**
 * 获取套餐详情
 * 遵循官方 CodeBuddy web client 逻辑（HAR 验证）：
 * flagship > premium > standard > youth > free/trial
 */
export function getPlanDetail(account: CodebuddySuiteAccountBase): CodebuddyPlanDetail {
  const profile = asRecord(account.profile_raw);
  const accountType = typeof profile?.type === 'string' ? profile.type.toLowerCase() : '';

  // 企业账号类型优先
  if (ENTERPRISE_ACCOUNT_TYPES.includes(accountType)) {
    return {
      type: 'pro',
      isPro: true,
      isTrial: false,
      badge: 'ENTERPRISE',
      packageCode: null,
      tier: 'enterprise',
    };
  }

  const all = extractResourceAccounts(account);
  const active = all.filter((a) => {
    const s = typeof a.Status === 'number' ? a.Status : -1;
    return s === RESOURCE_STATUS.valid || s === RESOURCE_STATUS.usedUp;
  });

  // 按官方优先级选取最高付费档
  const paidOrder = [
    PACKAGE_CODE.flagshipMon,
    PACKAGE_CODE.premiumMon,
    PACKAGE_CODE.proYear,
    PACKAGE_CODE.proMon,
    PACKAGE_CODE.youthMon,
  ] as const;

  for (const code of paidOrder) {
    const pkg = active.find((a) => typeof a.PackageCode === 'string' && a.PackageCode === code);
    if (pkg) {
      const resolved = resolvePlanTierFromPackageCode(code);
      if (resolved) {
        return {
          type: 'pro',
          isPro: resolved.isPro,
          isTrial: false,
          badge: resolved.badge,
          packageCode: code,
          tier: resolved.tier,
        };
      }
    }
  }

  const hasGift = active.some((a) => {
    const c = typeof a.PackageCode === 'string' ? a.PackageCode : '';
    return c === PACKAGE_CODE.gift;
  });

  if (hasGift) {
    return {
      type: 'free',
      isPro: false,
      isTrial: true,
      badge: 'TRIAL',
      packageCode: PACKAGE_CODE.gift,
      tier: 'trial',
    };
  }

  if (all.length === 0) {
    return planBadgeFallback(account);
  }

  return {
    type: 'free',
    isPro: false,
    isTrial: false,
    badge: 'FREE',
    packageCode: null,
    tier: 'free',
  };
}

/**
 * 套餐徽章回退逻辑
 */
function planBadgeFallback(account: CodebuddySuiteAccountBase): CodebuddyPlanDetail {
  const payment = account.payment_type?.toLowerCase() || '';
  const plan = account.plan_type?.toLowerCase() || '';
  const source = payment || plan;

  if (source.includes('enterprise') || source.includes('企业')) {
    return { type: 'pro', isPro: true, isTrial: false, badge: 'ENTERPRISE', packageCode: null, tier: 'enterprise' };
  }
  if (source.includes('flagship') || source.includes('旗舰')) {
    return { type: 'pro', isPro: true, isTrial: false, badge: 'FLAGSHIP', packageCode: null, tier: 'flagship' };
  }
  if (source.includes('premium') || source.includes('高级')) {
    return { type: 'pro', isPro: true, isTrial: false, badge: 'PREMIUM', packageCode: null, tier: 'premium' };
  }
  if (source.includes('standard') || source.includes('标准') || source.includes('pro')) {
    return { type: 'pro', isPro: true, isTrial: false, badge: 'STANDARD', packageCode: null, tier: 'standard' };
  }
  if (source.includes('youth') || source.includes('青春')) {
    return { type: 'pro', isPro: true, isTrial: false, badge: 'YOUTH', packageCode: null, tier: 'youth' };
  }
  if (source.includes('trial') || source.includes('体验')) {
    return { type: 'free', isPro: false, isTrial: true, badge: 'TRIAL', packageCode: null, tier: 'trial' };
  }
  if (source.includes('free') || source.includes('免费')) {
    return { type: 'free', isPro: false, isTrial: false, badge: 'FREE', packageCode: null, tier: 'free' };
  }
  if (source) {
    const raw = (account.payment_type || account.plan_type || 'UNKNOWN').toUpperCase();
    return { type: 'free', isPro: false, isTrial: false, badge: raw, packageCode: null, tier: 'unknown' };
  }
  return { type: 'free', isPro: false, isTrial: false, badge: 'UNKNOWN', packageCode: null, tier: 'unknown' };
}

/**
 * 获取套餐徽章
 */
export function getPlanBadge(account: CodebuddySuiteAccountBase): string {
  return getPlanDetail(account).badge;
}

/**
 * 获取套餐徽章样式类
 */
export function getPlanBadgeClass(badge: string): string {
  switch (badge) {
    case 'FREE':
      return 'plan-badge plan-free';
    case 'TRIAL':
      return 'plan-badge plan-trial';
    case 'YOUTH':
      return 'plan-badge plan-youth';
    case 'STANDARD':
    case 'PRO':
      return 'plan-badge plan-standard';
    case 'PREMIUM':
      return 'plan-badge plan-premium';
    case 'FLAGSHIP':
      return 'plan-badge plan-flagship';
    case 'ENTERPRISE':
      return 'plan-badge plan-enterprise';
    default:
      return 'plan-badge plan-unknown';
  }
}

/**
 * 徽章显示文案（中文）
 */
export function getPlanBadgeLabel(badge: string): string {
  switch (badge) {
    case 'FREE':
      return '体验版';
    case 'TRIAL':
      return '试用';
    case 'YOUTH':
      return '青春版';
    case 'STANDARD':
    case 'PRO':
      return '标准版';
    case 'PREMIUM':
      return '高级版';
    case 'FLAGSHIP':
      return '旗舰版';
    case 'ENTERPRISE':
      return '企业版';
    default:
      return badge || '未知';
  }
}

/**
 * 获取使用量信息
 */
export function getUsage(account: CodebuddySuiteAccountBase): CodebuddyUsage {
  const code = account.dosage_notify_code || '';
  return {
    dosageNotifyCode: code,
    dosageNotifyZh: account.dosage_notify_zh || undefined,
    dosageNotifyEn: account.dosage_notify_en || undefined,
    paymentType: account.payment_type || undefined,
    isNormal: !code || code === '0' || code === 'USAGE_NORMAL',
    inlineSuggestionsUsedPercent: null,
    chatMessagesUsedPercent: null,
    allowanceResetAt: null,
  };
}

/**
 * 获取账号状态
 */
export function getAccountStatus(account: CodebuddySuiteAccountBase): string {
  return account.status || 'unknown';
}

/**
 * 获取积分余额
 */
export function getCreditsBalance(account: CodebuddySuiteAccountBase): number | null {
  const active = extractResourceAccounts(account).filter(isActiveResource);
  if (active.length === 0) return null;
  const balance = active.reduce((sum, item) => sum + parseCycleRemain(item), 0);
  if (!Number.isFinite(balance)) return null;
  return Math.max(0, balance);
}

/**
 * 获取账号显示邮箱
 */
export function getAccountDisplayEmail(account: CodebuddySuiteAccountBase): string {
  return account.email || account.nickname || account.uid || account.id;
}

/**
 * 获取账号显示名称
 */
export function getAccountDisplayName(account: CodebuddySuiteAccountBase): string {
  return account.nickname || account.email || account.uid || account.id;
}

/**
 * 获取官方配额模型
 */
export function getOfficialQuotaModel(account: CodebuddySuiteAccountBase): OfficialQuotaModel {
  const updatedAt = getAccountQuotaUpdatedAtMs(account);
  const empty: OfficialQuotaResource = {
    packageCode: PACKAGE_CODE.extra,
    packageName: null,
    cycleStartTime: null,
    cycleEndTime: null,
    deductionEndTime: null,
    expiredTime: null,
    total: 0,
    remain: 0,
    used: 0,
    usedPercent: 0,
    remainPercent: null,
    refreshAt: null,
    expireAt: null,
    isBasePackage: false,
  };

  const all = extractResourceAccounts(account).filter(isActiveResource);
  if (all.length === 0) {
    return { resources: [], extra: empty, updatedAt };
  }

  const pro = all.filter(isProPackage);
  const extras = all.filter(isExtraPackage);
  const trialOrFreeMon = all.filter(isTrialOrFreeMonPackage);
  const free = all.filter((a) => {
    const code = typeof a.PackageCode === 'string' ? a.PackageCode : '';
    return code === PACKAGE_CODE.free;
  });
  const activity = all.filter((a) => isBonusPackage(a) || (typeof a.PackageCode === 'string' && a.PackageCode === PACKAGE_CODE.activity));

  const mergedTrialOrFreeMon = aggregateCycleResources(trialOrFreeMon);
  const mergedFree = aggregateCycleResources(free);
  // 付费主档优先展示，其后赠送包/体验包
  const ordered = [...pro, mergedTrialOrFreeMon, ...activity, mergedFree].filter(
    (item): item is Record<string, unknown> => item != null && !!item.PackageCode,
  );
  const resources = ordered.map(toOfficialQuotaResource);

  const mergedExtra = aggregateCycleResources(extras);
  const extra = mergedExtra ? toOfficialQuotaResource(mergedExtra) : empty;
  return { resources, extra, updatedAt };
}

/**
 * 解析包名称
 */
function resolvePackageName(resource: OfficialQuotaResource): string {
  if (resource.packageCode === PACKAGE_CODE.extra) return '加量包';
  if (resource.packageCode === PACKAGE_CODE.activity) return '活动赠送包';
  if (resource.packageCode === PACKAGE_CODE.versionBonus) return '版本赠送包';
  if (resource.packageCode === PACKAGE_CODE.compensation || resource.packageCode === PACKAGE_CODE.newUserBonus) {
    return '权益赠送包';
  }
  if (
    resource.packageCode === PACKAGE_CODE.free ||
    resource.packageCode === PACKAGE_CODE.gift ||
    resource.packageCode === PACKAGE_CODE.freeMon
  ) {
    return '基础体验包';
  }
  if (resource.packageCode === PACKAGE_CODE.flagshipMon) return '旗舰版订阅';
  if (resource.packageCode === PACKAGE_CODE.premiumMon) return '高级版订阅';
  if (resource.packageCode === PACKAGE_CODE.proMon || resource.packageCode === PACKAGE_CODE.proYear) {
    return '标准版订阅';
  }
  if (resource.packageCode === PACKAGE_CODE.youthMon) return '青春版订阅';
  return resource.packageName || '基础包';
}

/**
 * 获取配额显示项列表
 */
export function getQuotaDisplayItems(account: CodebuddySuiteAccountBase): QuotaDisplayItem[] {
  const model = getOfficialQuotaModel(account);
  const items: QuotaDisplayItem[] = [];

  for (const resource of model.resources) {
    if (resource.total <= 0 && resource.remain <= 0) continue;

    const remainPercent = resource.remainPercent ?? Math.max(0, 100 - resource.usedPercent);
    const quotaClass = remainPercent <= 10 ? 'low' : remainPercent <= 30 ? 'medium' : 'high';

    items.push({
      key: `base-${resource.packageCode || items.length}`,
      label: resolvePackageName(resource),
      used: resource.used,
      total: resource.total,
      remain: resource.remain,
      usedPercent: resource.usedPercent,
      remainPercent: resource.remainPercent,
      quotaClass,
      refreshAt: resource.refreshAt,
    });
  }

  if (model.extra.total > 0 || model.extra.remain > 0) {
    const remainPercent = model.extra.remainPercent ?? Math.max(0, 100 - model.extra.usedPercent);
    const quotaClass = remainPercent <= 10 ? 'low' : remainPercent <= 30 ? 'medium' : 'high';

    items.push({
      key: 'extra',
      label: '加量包',
      used: model.extra.used,
      total: model.extra.total,
      remain: model.extra.remain,
      usedPercent: model.extra.usedPercent,
      remainPercent: model.extra.remainPercent,
      quotaClass,
      refreshAt: model.extra.refreshAt,
    });
  }

  return items;
}

/**
 * 获取配额分组聚合数据
 */
export function getQuotaCategoryGroups(account: CodebuddySuiteAccountBase, t: (key: string, defaultValue?: string) => string): QuotaCategoryGroup[] {
  const model = getOfficialQuotaModel(account);

  const baseItems: OfficialQuotaResource[] = [];
  const activityItems: OfficialQuotaResource[] = [];
  const extraItems: OfficialQuotaResource[] = [];
  const otherItems: OfficialQuotaResource[] = [];

  for (const resource of model.resources) {
    const code = resource.packageCode;
    if (
      code === PACKAGE_CODE.free ||
      code === PACKAGE_CODE.gift ||
      code === PACKAGE_CODE.freeMon ||
      code === PACKAGE_CODE.proMon ||
      code === PACKAGE_CODE.proYear ||
      code === PACKAGE_CODE.youthMon ||
      code === PACKAGE_CODE.premiumMon ||
      code === PACKAGE_CODE.flagshipMon
    ) {
      baseItems.push(resource);
    } else if (
      code === PACKAGE_CODE.activity ||
      code === PACKAGE_CODE.versionBonus ||
      code === PACKAGE_CODE.compensation ||
      code === PACKAGE_CODE.newUserBonus
    ) {
      activityItems.push(resource);
    } else {
      otherItems.push(resource);
    }
  }

  if (model.extra.total > 0 || model.extra.remain > 0 || model.extra.used > 0) {
    extraItems.push(model.extra);
  }

  const aggregate = (items: OfficialQuotaResource[]): Omit<QuotaCategoryGroup, 'key' | 'label' | 'items' | 'visible'> => {
    const total = items.reduce((sum, r) => sum + r.total, 0);
    const remain = items.reduce((sum, r) => sum + r.remain, 0);
    const used = items.reduce((sum, r) => sum + r.used, 0);
    const usedPercent = total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;
    const remainPercent = total > 0 ? Math.max(0, Math.min(100, (remain / total) * 100)) : null;
    const quotaClass =
      remainPercent != null ? (remainPercent <= 10 ? 'critical' : remainPercent <= 30 ? 'low' : remainPercent <= 60 ? 'medium' : 'high') : 'high';
    return { total, remain, used, usedPercent, remainPercent, quotaClass };
  };

  const baseAgg = aggregate(baseItems);
  const activityAgg = aggregate(activityItems);
  const extraAgg = aggregate(extraItems);
  const otherAgg = aggregate(otherItems);

  return [
    { key: 'base', label: t('codebuddy.quotaCategory.base', '基础体验包'), ...baseAgg, items: baseItems, visible: baseAgg.total > 0 },
    { key: 'activity', label: t('codebuddy.quotaCategory.activity', '活动赠送包'), ...activityAgg, items: activityItems, visible: activityAgg.total > 0 },
    { key: 'extra', label: t('codebuddy.quotaCategory.extra', '加量包'), ...extraAgg, items: extraItems, visible: extraAgg.total > 0 },
    { key: 'other', label: t('codebuddy.quotaCategory.other', '其他'), ...otherAgg, items: otherItems, visible: otherAgg.total > 0 },
  ];
}
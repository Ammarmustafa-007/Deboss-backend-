/**
 * The arithmetic of the HR and compensation rules, free of the database so it can be tested against the
 * client document's worked examples. Everything here is a pure function of its inputs.
 */

export type Tier = { from: number; rate: number };
export type HrRules = {
  dispatch_sales: { min_active_sales: number; rate: number };
  dispatcher: { tiers: Tier[] };
  brokerage_sales: { tiers: Tier[] };
  brokerage_operations: { tiers: Tier[] };
  fronter_per_lead_pkr: number;
  manager_share: Record<"DISPATCH_SALES_MANAGER" | "DISPATCH_MANAGER" | "BROKERAGE_SALES_MANAGER" | "BROKERAGE_OPERATIONS_MANAGER", number>;
  paid_leaves_per_month: number;
};
export type ExitType = "NOTICE_SERVED" | "NO_NOTICE" | "FIRED";
export type CostType = "COMPANY_SHARED" | "ONE_DEPARTMENT" | "TWO_DEPARTMENTS" | "COMPANY_ONLY";

export const round = (value: number) => Math.round(value * 100) / 100;

/** The rate earned at a gross figure: the highest level reached, or none below the first target. */
export function tierFor(gross: number, tiers: Tier[]) {
  const sorted = [...tiers].sort((a, b) => a.from - b.from);
  const reached = sorted.filter((tier) => gross >= tier.from).pop() ?? null;
  const next = sorted.find((tier) => tier.from > gross) ?? null;
  return { target: sorted[0]?.from ?? 0, rate: reached?.rate ?? 0, reached: Boolean(reached), next };
}

/** Tiered commission: the rate reached, on the whole amount above the first target. */
export function tieredCommission(gross: number, tiers: Tier[]) {
  const { target, rate, reached } = tierFor(gross, tiers);
  const commissionable = reached ? gross - target : 0;
  return { rate, commissionable: round(commissionable), commission: round(commissionable * rate / 100) };
}

/** Dispatch Sales Agent: a flat rate on everything paid, once the month's active sales target is met. */
export function dispatchSalesCommission(paid: number, activeSales: number, rule: HrRules["dispatch_sales"]) {
  const met = activeSales >= rule.min_active_sales;
  return { rate: met ? rule.rate : 0, commissionable: met ? round(paid) : 0, commission: met ? round(paid * rule.rate / 100) : 0 };
}

const iso = (date: Date) => date.toISOString().slice(0, 10);

/** Monday to Friday of a YYYY-MM month, as YYYY-MM-DD. */
export function workingDays(period: string) {
  const [year, month] = period.split("-").map(Number);
  const days: string[] = [];
  for (let date = new Date(Date.UTC(year, month - 1, 1)); date.getUTCMonth() === month - 1; date = new Date(date.getTime() + 86_400_000)) {
    if (![0, 6].includes(date.getUTCDay())) days.push(iso(date));
  }
  return days;
}

/**
 * Base pay for the month. Part months pay base x days employed / working days. Leave is paid; absences beyond the
 * paid-leave allowance are deducted at base / working days, unless a manager turned them into Leave.
 */
export function basePay(input: { base: number; period: string; joinedOn: string; lastWorkingDay: string | null; leaveDays: string[]; absentDays: string[]; paidLeaves: number }) {
  const all = workingDays(input.period);
  const employed = all.filter((day) => day >= input.joinedOn && (!input.lastWorkingDay || day <= input.lastWorkingDay));
  const inRange = (days: string[]) => days.filter((day) => employed.includes(day));
  const leave = inRange(input.leaveDays).length;
  const absent = inRange(input.absentDays).length;
  const paidLeaveUsed = Math.min(absent, input.paidLeaves);
  const unpaid = absent - paidLeaveUsed;
  const perDay = all.length ? input.base / all.length : 0;
  const earned = round(perDay * employed.length);
  const deduction = round(Math.min(perDay * unpaid, earned));
  return { working_days: all.length, employed_days: employed.length, days_worked: employed.length - leave - absent, leave_days: leave, absent_days: absent, paid_leave_used: paidLeaveUsed, unpaid_absences: unpaid, base_earned: earned, leave_deduction: deduction, base_net: round(earned - deduction) };
}

/** People leaving without notice, or fired, get base for days worked and no commission. */
export const earnsVariablePay = (exitType: ExitType | null) => exitType === null || exitType === "NOTICE_SERVED";

/** One cost's share per department (USD). Shared costs split by number of employees; Company only costs are not charged. */
export function allocateCost(cost: { amount: number; cost_type: CostType; department_ids: string[] }, headcount: Map<string, number>) {
  const shares = new Map<string, number>();
  if (cost.cost_type === "COMPANY_ONLY") return shares;
  if (cost.cost_type === "ONE_DEPARTMENT") { shares.set(cost.department_ids[0], cost.amount); return shares; }
  const departments = cost.cost_type === "TWO_DEPARTMENTS" ? cost.department_ids : [...headcount.keys()];
  const people = departments.reduce((sum, id) => sum + (headcount.get(id) ?? 0), 0);
  // Two departments with nobody on payroll this month: split evenly so the cost is not lost.
  for (const id of departments) shares.set(id, people ? cost.amount * (headcount.get(id) ?? 0) / people : cost.amount / departments.length);
  return shares;
}

/** Profit share: a percentage of the net profit of a department, or of a manager's team when it has two managers. Zero in a loss month. */
export const profitShare = (netProfit: number, percent: number) => round(Math.max(0, netProfit) * percent / 100);

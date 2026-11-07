/** Test helper: an in-memory stand-in for the Supabase query builder, so routes run without a database. */
let counter = 0;

export function fakeSupabase(tables: Record<string, any[]>) {
  const keys: Record<string, string[]> = { employee_records: ["user_id"], attendance_records: ["user_id", "work_date"], payroll_months: ["period"] };
  // Embedded selects such as "*, dispatch_trucks(*)" resolve through the matching *_id column, one level deep.
  const links: Record<string, string> = { dispatch_trucks: "truck_id", dispatch_carriers: "carrier_id", chat_conversations: "conversation_id" };
  const embed = (row: any, names: string[]): any => {
    const copy = { ...row };
    for (const name of names) if (links[name] && row[links[name]] !== undefined) {
      const found = (tables[name] ?? []).find((other) => other.id === row[links[name]]);
      copy[name] = found ? embed(found, Object.keys(links).filter((other) => other !== name)) : null;
    }
    return copy;
  };
  const from = (table: string) => {
    const filters: ((row: any) => boolean)[] = [];
    let action: { kind: string; value?: any; onConflict?: string; ignoreDuplicates?: boolean } = { kind: "select" };
    let counting = false;
    let embeds: string[] = [];
    const rows = () => (tables[table] ??= []);
    const run = () => {
      const matching = rows().filter((row) => filters.every((check) => check(row)));
      if (action.kind === "update") matching.forEach((row) => Object.assign(row, action.value));
      if (action.kind === "delete") tables[table] = rows().filter((row) => !matching.includes(row));
      if (action.kind === "insert") { const added = [action.value].flat().map((row) => ({ id: `00000000-0000-4000-9000-${String(++counter).padStart(12, "0")}`, ...row })); rows().push(...added); return added; }
      if (action.kind === "upsert") {
        const key = action.onConflict ? String(action.onConflict).split(",").map((name: string) => name.trim()) : keys[table] ?? (table === "brokerage_customers" ? ["lead_id"] : ["id"]);
        for (const value of [action.value].flat()) {
          const found = rows().find((row) => key.every((name: string) => row[name] === value[name]));
          if (found) { if (!action.ignoreDuplicates) Object.assign(found, value); } else rows().push({ ...value });
        }
        return [action.value].flat();
      }
      return embeds.length ? matching.map((row) => embed(row, embeds)) : matching;
    };
    const builder: any = {
      select: (columns?: string, options?: { count?: string; head?: boolean }) => { if (options?.count) counting = true; embeds = [...(columns ?? "").matchAll(/(\w+)\(/g)].map((match) => match[1]); return builder; }, order: () => builder, limit: () => builder,
      is: (key: string, value: unknown) => { filters.push((row) => (row[key] ?? null) === value); return builder; },
      insert: (value: any) => { action = { kind: "insert", value }; return builder; },
      update: (value: any) => { action = { kind: "update", value }; return builder; },
      upsert: (value: any, options?: { onConflict?: string; ignoreDuplicates?: boolean }) => { action = { kind: "upsert", value, onConflict: options?.onConflict, ignoreDuplicates: options?.ignoreDuplicates }; return builder; },
      delete: () => { action = { kind: "delete" }; return builder; },
      eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
      neq: (key: string, value: unknown) => { filters.push((row) => row[key] !== value); return builder; },
      in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return builder; },
      gte: (key: string, value: string) => { filters.push((row) => row[key] != null && row[key] >= value); return builder; },
      lt: (key: string, value: string) => { filters.push((row) => row[key] != null && row[key] < value); return builder; },
      lte: (key: string, value: string) => { filters.push((row) => row[key] != null && row[key] <= value); return builder; },
      not: (key: string, op: string, value: string) => { filters.push((row) => op === "in" ? !value.slice(1, -1).split(",").includes(row[key]) : row[key] != null); return builder; },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => void) => { const data = run(); resolve(counting ? { data: null, count: data.length, error: null } : { data, error: null }); },
    };
    return builder;
  };
  return { from } as never;
}

const ids = Object.fromEntries(["boss", "m1", "m2", "a1", "a2", "a3", "opsm", "opsa", "gone", "stays"].map((name, index) => [name, `00000000-0000-4000-8000-00000000000${index}`]));

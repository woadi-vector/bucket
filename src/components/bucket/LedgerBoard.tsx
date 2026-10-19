import { useCallback, useMemo, useRef, useState } from "react";
import {
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  CsvExportModule,
  ExternalFilterModule,
  ModuleRegistry,
  NumberFilterModule,
  PaginationModule,
  PinnedRowModule,
  QuickFilterModule,
  RenderApiModule,
  RowAutoHeightModule,
  TextFilterModule,
  ValidationModule,
  themeQuartz,
  type ColDef,
  type GridApi,
  type ICellRendererParams,
  type IRowNode,
  type ValueFormatterParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import {
  BarSeriesModule,
  CategoryAxisModule,
  ModuleRegistry as ChartsRegistry,
  NumberAxisModule,
  type AgCartesianChartOptions,
} from "ag-charts-community";
import { AgCharts } from "ag-charts-react";
import {
  GROUP_OF,
  OUTCOMES,
  dollarsByOutcome,
  type LedgerRow,
  type Outcome,
  type OutcomeGroup,
} from "@/lib/bucket/ledger-rows";

/**
 * The ledger as a working table: AG Grid for the rows, AG Charts for where the money went.
 *
 * The chart is drawn from whatever the grid is showing. Filter to "Let go" or search for
 * "shoes", and the chart redraws from those rows, so the picture always matches the list
 * beside it. The pinned bottom row totals the same filtered rows.
 *
 * Client only. The route lazy-loads this file after hydration, so neither library runs on the
 * server or weighs down the main app bundle.
 */

// Only the modules this page uses, so the lazy chunk stays a fraction of the full bundles.
ModuleRegistry.registerModules([
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  TextFilterModule,
  NumberFilterModule,
  QuickFilterModule,
  ExternalFilterModule,
  PaginationModule,
  PinnedRowModule,
  RowAutoHeightModule,
  CellStyleModule,
  CsvExportModule,
  RenderApiModule,
  ...(import.meta.env.DEV ? [ValidationModule] : []),
]);
ChartsRegistry.registerModules([BarSeriesModule, CategoryAxisModule, NumberAxisModule]);

const GROUP_COLOR: Record<OutcomeGroup, string> = {
  paid: "#475569",
  waiting: "#d97706",
  released: "#0b7a58",
  refused: "#7c6bb0",
};

const GROUP_LABEL: Record<OutcomeGroup, string> = {
  paid: "Money moved",
  waiting: "Reserved, waiting",
  released: "Released by Bucket",
  refused: "Never reached PayPal",
};

const theme = themeQuartz.withParams({
  accentColor: "#0b7a58",
  backgroundColor: "#ffffff",
  foregroundColor: "#1c2a24",
  headerBackgroundColor: "#f6f5ef",
  headerFontWeight: 600,
  oddRowBackgroundColor: "#fbfaf6",
  rowHoverColor: "#eef6f1",
  borderColor: "#e7e4da",
  wrapperBorderRadius: 16,
  fontFamily: "inherit",
  fontSize: 13,
  browserColorScheme: "light",
});

const usd = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? "" : `$${(cents / 100).toFixed(2)}`;
const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

function OutcomeChip({ value }: ICellRendererParams<LedgerRow, Outcome>) {
  if (!value) return null;
  const color = GROUP_COLOR[GROUP_OF[value]];
  return (
    <span
      style={{ color, backgroundColor: `${color}14`, borderColor: `${color}40` }}
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold leading-5"
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {value}
    </span>
  );
}

function WhatCell({ data }: ICellRendererParams<LedgerRow>) {
  if (!data) return null;
  const detail = data.detail
    ? data.outcome === "Overruled"
      ? `Agent picked: ${data.detail}`
      : data.detail
    : null;
  // One line each, full text on hover, so a row's height never depends on this column's width.
  return (
    <div
      className="min-w-0 py-2 leading-snug"
      title={detail ? `${data.what}\n${detail}` : data.what}
    >
      <div className="truncate font-medium">{data.what}</div>
      {detail && <div className="truncate text-xs text-slate-500">{detail}</div>}
    </div>
  );
}

/** Wrapped secondary text with its own line height; AG Grid's row line height is for one line. */
function TextCell({ value }: ICellRendererParams<LedgerRow, string | null>) {
  if (!value) return null;
  return <div className="py-2 text-xs leading-snug text-slate-600">{value}</div>;
}

function AuthCell({ value, node }: ICellRendererParams<LedgerRow, string | null>) {
  if (node.rowPinned) return null;
  if (!value) return <span className="text-xs text-slate-400">no order created</span>;
  return <code className="font-mono text-xs">{value}</code>;
}

type Totals = { rows: number; cents: number };

export default function LedgerBoard({ rows }: { rows: LedgerRow[] }) {
  const apiRef = useRef<GridApi<LedgerRow> | null>(null);
  const [shown, setShown] = useState<LedgerRow[]>(rows);
  const [search, setSearch] = useState("");
  // Wide screens: the table grows to fit its rows. Narrow screens scroll sideways, and AG Grid's
  // auto height does not leave room for that scrollbar, so the table gets a fixed height instead.
  const [wide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  const [groups, setGroups] = useState<Set<OutcomeGroup>>(
    () => new Set<OutcomeGroup>(["paid", "waiting", "released", "refused"]),
  );
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const columns = useMemo<ColDef<LedgerRow>[]>(
    () => [
      {
        field: "at",
        headerName: "When (UTC)",
        width: 172,
        sort: "desc",
        valueFormatter: (p: ValueFormatterParams<LedgerRow, number>) =>
          p.value ? when(p.value) : "",
        filter: "agNumberColumnFilter",
        cellClass: "text-slate-500 tabular-nums",
      },
      {
        field: "what",
        headerName: "Purchase or request",
        flex: 2,
        minWidth: 200,
        cellRenderer: WhatCell,
        autoHeight: true,
        filter: "agTextColumnFilter",
        getQuickFilterText: (p) => `${p.data.what} ${p.data.detail ?? ""}`,
      },
      {
        field: "tag",
        headerName: "Bucket",
        width: 104,
        valueFormatter: (p) => p.value ?? "",
        filter: "agTextColumnFilter",
      },
      {
        field: "amountCents",
        headerName: "Amount",
        width: 110,
        type: "rightAligned",
        valueFormatter: (p) => usd(p.value),
        filter: "agNumberColumnFilter",
        cellClass: "tabular-nums font-medium",
      },
      {
        field: "outcome",
        headerName: "Outcome",
        width: 142,
        cellRenderer: OutcomeChip,
        filter: "agTextColumnFilter",
      },
      {
        field: "decidedBy",
        headerName: "Decided by",
        width: 160,
        cellRenderer: TextCell,
        wrapText: true,
        autoHeight: true,
        filter: "agTextColumnFilter",
      },
      {
        field: "note",
        headerName: "Reason or error",
        flex: 2,
        minWidth: 150,
        wrapText: true,
        autoHeight: true,
        cellRenderer: TextCell,
        filter: "agTextColumnFilter",
      },
      {
        field: "authorizationId",
        headerName: "PayPal authorization",
        width: 184,
        cellRenderer: AuthCell,
        filter: "agTextColumnFilter",
      },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef<LedgerRow>>(
    () => ({ sortable: true, resizable: true, floatingFilter: false }),
    [],
  );

  const totals: Totals = useMemo(
    () => ({ rows: shown.length, cents: shown.reduce((s, r) => s + (r.amountCents ?? 0), 0) }),
    [shown],
  );

  const pinnedBottom = useMemo(
    () => [
      {
        id: "__total",
        what: `Total of ${totals.rows} matching rows`,
        amountCents: totals.cents,
      } as unknown as LedgerRow,
    ],
    [totals],
  );

  /** Everything the grid currently displays, after filters and search, in display order. */
  const readShown = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const out: LedgerRow[] = [];
    api.forEachNodeAfterFilterAndSort((n: IRowNode<LedgerRow>) => {
      if (n.data) out.push(n.data);
    });
    setShown(out);
  }, []);

  const toggleGroup = (g: OutcomeGroup) => {
    setGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g) && next.size > 1) next.delete(g);
      else next.add(g);
      groupsRef.current = next;
      return next;
    });
    // The external filter reads groupsRef, which is already updated above.
    queueMicrotask(() => apiRef.current?.onFilterChanged());
  };

  const chartOptions = useMemo<AgCartesianChartOptions>(() => {
    const data = dollarsByOutcome(shown).filter((d) => d.count > 0);
    return {
      data,
      height: 280,
      background: { fill: "transparent" },
      padding: { top: 8, right: 96, bottom: 8, left: 8 },
      series: [
        {
          type: "bar",
          direction: "horizontal",
          xKey: "outcome",
          yKey: "dollars",
          yName: "Dollars",
          cornerRadius: 6,
          itemStyler: ({ datum }: { datum: { group: OutcomeGroup } }) => ({
            fill: GROUP_COLOR[datum.group],
          }),
          label: {
            enabled: true,
            placement: "outside-end",
            color: "#334155",
            fontWeight: 600,
            formatter: ({ datum }: { datum: { dollars: number; count: number } }) =>
              datum.dollars > 0
                ? `$${datum.dollars.toFixed(2)} · ${datum.count}`
                : `${datum.count} with no price`,
          },
          tooltip: {
            renderer: ({
              datum,
            }: {
              datum: { outcome: string; dollars: number; count: number };
            }) => ({
              heading: datum.outcome,
              data: [
                { label: "Rows", value: String(datum.count) },
                { label: "Dollars", value: `$${datum.dollars.toFixed(2)}` },
              ],
            }),
          },
        },
      ],
      axes: {
        x: {
          type: "category",
          position: "left",
          label: { color: "#334155", fontWeight: 600 },
          line: { enabled: false },
        },
        y: {
          type: "number",
          position: "bottom",
          label: { formatter: ({ value }: { value: number }) => `$${value}`, color: "#64748b" },
          gridLine: { style: [{ stroke: "#ece9df", lineDash: [3, 3] }] },
        },
      },
      legend: { enabled: false },
    };
  }, [shown]);

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-[#e7e4da] bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
          <h2 className="text-sm font-semibold">Where the agent's money went</h2>
          <p className="text-xs text-slate-500">
            Drawn from the rows the table below is showing. Filter the table and this follows.
          </p>
        </div>
        {shown.length === 0 ? (
          <p className="px-1 py-10 text-center text-sm text-slate-500">No rows match.</p>
        ) : (
          <AgCharts options={chartOptions} />
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(GROUP_LABEL) as OutcomeGroup[]).map((g) => {
            const on = groups.has(g);
            const count = rows.filter((r) => r.group === g).length;
            return (
              <button
                key={g}
                type="button"
                onClick={() => toggleGroup(g)}
                aria-pressed={on}
                className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition"
                style={
                  on
                    ? {
                        color: GROUP_COLOR[g],
                        borderColor: `${GROUP_COLOR[g]}55`,
                        backgroundColor: `${GROUP_COLOR[g]}12`,
                      }
                    : { color: "#94a3b8", borderColor: "#e2e8f0", backgroundColor: "#fff" }
                }
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: on ? GROUP_COLOR[g] : "#cbd5e1" }}
                />
                {GROUP_LABEL[g]} · {count}
              </button>
            );
          })}
          <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search purchases, reasons, ids"
              aria-label="Search the ledger"
              className="h-9 w-full rounded-xl sm:w-64 border border-[#e7e4da] bg-white px-3 text-sm outline-none focus:border-[#0b7a58]"
            />
            <button
              type="button"
              onClick={() =>
                apiRef.current?.exportDataAsCsv({
                  fileName: "bucket-paypal-ledger.csv",
                  skipPinnedBottom: true,
                  processCellCallback: (p) =>
                    p.column.getColId() === "at"
                      ? new Date(p.value as number).toISOString()
                      : p.column.getColId() === "amountCents"
                        ? p.value === null || p.value === undefined
                          ? ""
                          : ((p.value as number) / 100).toFixed(2)
                        : (p.value ?? ""),
                })
              }
              className="h-9 shrink-0 whitespace-nowrap rounded-xl border border-[#e7e4da] bg-white px-3 text-sm font-medium hover:border-[#0b7a58]"
            >
              Download CSV
            </button>
          </div>
        </div>

        <div style={wide ? undefined : { height: 600 }}>
          <AgGridReact<LedgerRow>
            domLayout={wide ? "autoHeight" : "normal"}
            // The height of a two-line row, so the table's own height is right before rows are measured.
            rowHeight={52}
            pagination
            paginationPageSize={25}
            paginationPageSizeSelector={[25, 50, 100]}
            theme={theme}
            rowData={rows}
            columnDefs={columns}
            defaultColDef={defaultColDef}
            getRowId={(p) => p.data.id}
            quickFilterText={search}
            pinnedBottomRowData={pinnedBottom}
            isExternalFilterPresent={() => groupsRef.current.size < 4}
            doesExternalFilterPass={(node) => !!node.data && groupsRef.current.has(node.data.group)}
            onGridReady={(e) => {
              apiRef.current = e.api;
              readShown();
            }}
            onModelUpdated={readShown}
            overlayNoRowsTemplate="No rows match."
            animateRows
            enableCellTextSelection
            suppressCellFocus
          />
        </div>
        <p className="text-xs text-slate-500">
          Outcomes: {OUTCOMES.join(", ")}. A decline has no amount because the agent picked nothing.
          An overrule's amount is what the agent would have spent.
        </p>
      </section>
    </div>
  );
}

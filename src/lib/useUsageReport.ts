import { useEffect, useState } from "react";
import { api } from "./api";
import { type UsageReport, USAGE_PAGE_SIZE } from "./usageCosts";

type ReportState = {
  key: string;
  report: UsageReport | null;
  loading: boolean;
  error: string;
};
export function useUsageReport(
  start: string,
  end: string,
  callPage: number,
  revision: number,
) {
  const key = `${start}|${end}`;
  const [state, setState] = useState<ReportState>({
    key,
    report: null,
    loading: true,
    error: "",
  });
  useEffect(() => {
    if (!start || !end || start > end) {
      setState({
        key,
        report: null,
        loading: false,
        error: "结束日期不能早于开始日期。",
      });
      return;
    }
    let live = true;
    setState((current) => ({
      key,
      report: current.key === key ? current.report : null,
      loading: true,
      error: "",
    }));
    const query = new URLSearchParams({
      start_date: start,
      end_date: end,
      offset: String((callPage - 1) * USAGE_PAGE_SIZE),
      limit: String(USAGE_PAGE_SIZE),
    });
    api<UsageReport>(`/usage?${query}`)
      .then((report) => {
        if (live) setState({ key, report, loading: false, error: "" });
      })
      .catch((cause: Error) => {
        if (live)
          setState((current) => ({
            ...current,
            loading: false,
            error: cause.message,
          }));
      });
    return () => {
      live = false;
    };
  }, [start, end, callPage, revision, key]);
  return state.key === key
    ? state
    : { key, report: null, loading: true, error: "" };
}

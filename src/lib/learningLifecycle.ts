const pending = new Map<() => Promise<void>, boolean>();

export function registerLearningFlush(flush: () => Promise<void>) {
  pending.set(flush, true);
  return () => {
    pending.set(flush, false);
    // Keep an unmounted editor's pending write visible to desktop shutdown.
    void flush().then(() => pending.delete(flush)).catch(() => {});
  };
}

export async function flushLearningDrafts() {
  const results = await Promise.allSettled([...pending.keys()].map(async (flush) => {
    await flush();
    if (!pending.get(flush)) pending.delete(flush);
  }));
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

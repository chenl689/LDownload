export type CompletionTask = {
  id: string;
  fileName: string;
  directory: string;
  status: string;
  kind: 'ordinary' | 'magnet';
};

export function allTasksCompleted(
  downloads: readonly { status: string }[],
  magnets: readonly { status: string }[],
): boolean {
  const tasks = [...downloads, ...magnets];
  return tasks.length > 0 && tasks.every(task => task.status === 'completed');
}

export function updateCompletionState(
  downloads: readonly CompletionTask[],
  magnets: readonly CompletionTask[],
  previousStatuses: Map<string, string>,
): { newlyCompleted: CompletionTask[]; allCompleted: boolean } {
  const tasks = [...downloads, ...magnets];
  const present = new Set<string>();
  const newlyCompleted: CompletionTask[] = [];
  for (const task of tasks) {
    present.add(task.id);
    if (task.status === 'completed' && previousStatuses.get(task.id) !== 'completed') newlyCompleted.push(task);
    previousStatuses.set(task.id, task.status);
  }
  for (const id of previousStatuses.keys()) if (!present.has(id)) previousStatuses.delete(id);
  return { newlyCompleted, allCompleted: allTasksCompleted(downloads, magnets) };
}

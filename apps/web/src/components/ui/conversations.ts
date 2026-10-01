import type { TaskSummary } from "@/lib/product-data";

// A chat is a conversation (ADR-0014): the tasks that share a conversation id.
// Its title is its first task's, its status and its address its newest task's —
// the same reading the sidebar's query makes.
export type ChatLine = { conversationId: string; title: string; latest: TaskSummary; updatedAt: string };

export function chatsOf(tasks: TaskSummary[]): ChatLine[] {
  const groups = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    const key = task.conversationId || task.id;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  const time = (value: string) => new Date(value).getTime();
  return [...groups.entries()].map(([conversationId, members]) => {
    const byCreated = [...members].sort((a, b) => time(a.createdAt) - time(b.createdAt));
    return {
      conversationId,
      title: byCreated[0].title,
      latest: byCreated[byCreated.length - 1],
      updatedAt: members.map((task) => task.updatedAt).sort((a, b) => time(b) - time(a))[0],
    };
  }).sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
}

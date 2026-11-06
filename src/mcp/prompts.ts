import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const PROMPT_NAMES = ["weekly_review", "traffic_drop", "landing_conversion"] as const;

const ANSWER_RULES = [
  "State the counter, exact dates and time zone taken from the result's query field.",
  "Relay data quality: sampling, incomplete periods and every warning that affects the conclusion.",
  "Keep observed facts separate from hypotheses; traffic statistics alone do not prove causes.",
  "Goal reaches are completions, not leads or customers.",
].join("\n- ");

const target = (counterId: string | undefined, connectionId: string | undefined): string =>
  [
    connectionId ? `connection_id=${connectionId}` : "the connection from metrika_status",
    counterId
      ? `counter_id=${counterId}`
      : "a counter chosen with the user via metrika_list_counters",
  ].join(", ");

const user = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

const args = z.object({
  connection_id: z.string().optional().describe("Connection ID, e.g. conn_demo."),
  counter_id: z.string().optional().describe("Counter ID."),
});

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "weekly_review",
    {
      title: "Weekly site review",
      description:
        "Last complete week vs the week before: traffic, sources, landing pages and goals.",
      argsSchema: args,
    },
    ({ connection_id, counter_id }) =>
      user(
        `Prepare a weekly review of the website for ${target(counter_id, connection_id)}.
1. Call metrika_describe_counter to learn the time zone and goal IDs.
2. Call metrika_compare_periods with periods.preset='last_two_complete_iso_weeks' and preset='overview'.
3. Repeat the comparison with preset='acquisition' and preset='landing_pages'.
4. If goals exist, ask which goal IDs matter (unless already known) and compare with preset='goals'.
5. Summarize the main changes in 5–8 bullet points, then list checks worth doing next.
Rules:
- ${ANSWER_RULES}`,
      ),
  );

  server.registerPrompt(
    "traffic_drop",
    {
      title: "Investigate a traffic drop",
      description: "Find where a drop in visits or goal completions is concentrated.",
      argsSchema: args.extend({
        metric: z.string().optional().describe("Metric ID, default ym:s:visits."),
      }),
    },
    ({ connection_id, counter_id, metric }) =>
      user(
        `Investigate a drop in ${metric ?? "ym:s:visits"} for ${target(counter_id, connection_id)}.
1. Confirm the drop with metrika_run_timeseries (group='day') over the last 28 complete days, and note incomplete buckets.
2. Agree on the two periods to compare with the user, then call metrika_compare_periods for preset='acquisition', 'devices', 'landing_pages' and 'geography'.
3. Rank segments by absolute change; remember a segment missing from a top-N list is unknown, not zero.
4. Report where the change is concentrated as observations, then hypotheses with the data that would confirm each.
Rules:
- ${ANSWER_RULES}`,
      ),
  );

  server.registerPrompt(
    "landing_conversion",
    {
      title: "Landing page conversion",
      description: "Which landing pages bring target visits for a goal.",
      argsSchema: args.extend({
        goal_id: z.string().optional().describe("Goal ID from metrika_describe_counter."),
      }),
    },
    ({ connection_id, counter_id, goal_id }) =>
      user(
        `Analyse landing page conversion for ${target(counter_id, connection_id)}${goal_id ? ` and goal ${goal_id}` : ""}.
1. ${goal_id ? `Confirm goal ${goal_id} exists` : "Pick the goal ID with the user"} via metrika_describe_counter.
2. Call metrika_run_report with preset='landing_pages', goal_ids=[<goal ID>], limit=50.
3. Point out pages with many visits but low conversion, and pages with high conversion but little traffic. Use conversion rate only together with visit counts.
Rules:
- ${ANSWER_RULES}`,
      ),
  );
}

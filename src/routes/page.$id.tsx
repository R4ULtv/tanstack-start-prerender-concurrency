import { createFileRoute } from "@tanstack/react-router";
import { loadPage } from "../workload";

export const Route = createFileRoute("/page/$id")({
  loader: ({ params }) => loadPage(params.id),
  component: Page,
});

function Page() {
  const { id, rows } = Route.useLoaderData();
  return (
    <main>
      <h1>Page {id}</h1>
      <ul>
        {rows.map((row, i) => (
          <li key={i}>{row}</li>
        ))}
      </ul>
    </main>
  );
}

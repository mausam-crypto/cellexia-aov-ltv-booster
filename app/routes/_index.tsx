import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.heading}>CELLEXIA</h1>
        <p style={styles.tagline}>AOV & LTV Booster</p>
        <p style={styles.copy}>
          In-cart volume upgrades, checkout upsells, purchase protection,
          trust & clinical proof badges, and subscription growth — in every
          language your store sells in.
        </p>
        {showForm && (
          <Form method="post" action="/auth/login" style={styles.form}>
            <input
              style={styles.input}
              type="text"
              name="shop"
              placeholder="my-shop-domain.myshopify.com"
            />
            <button style={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    background: "#FFFFFF",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    color: "#1D1D1B",
  },
  card: {
    maxWidth: "28rem",
    padding: "3rem",
    textAlign: "center",
    border: "1px solid #B2CEED",
    borderRadius: "12px",
  },
  heading: {
    letterSpacing: "0.35em",
    margin: 0,
    fontSize: "1.5rem",
  },
  tagline: {
    textTransform: "uppercase",
    letterSpacing: "0.15em",
    fontSize: "0.75rem",
    color: "#5b7fa6",
    marginTop: "0.5rem",
  },
  copy: { lineHeight: 1.6, fontSize: "0.9rem" },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    marginTop: "1.5rem",
  },
  input: {
    padding: "0.65rem 0.9rem",
    borderRadius: "8px",
    border: "1px solid #d0d7de",
    fontSize: "0.9rem",
  },
  button: {
    padding: "0.65rem 0.9rem",
    borderRadius: "8px",
    border: "none",
    background: "#1D1D1B",
    color: "#FFFFFF",
    fontSize: "0.9rem",
    cursor: "pointer",
  },
};

import type { Metadata } from "next";
import Link from "next/link";
import { logout } from "./actions";
import { currentUser } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "FareWatch",
  description: "Watches the price of your booked flights and hotels and tells you when it drops.",
  appleWebApp: { capable: true, title: "FareWatch", statusBarStyle: "default" },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body>
        <div className="container">
          <header className="top">
            <Link href="/" className="brand">✈️ FareWatch</Link>
            {user && (
              <form action={logout} className="row">
                <span className="muted small">{user.email}</span>
                <button className="secondary" type="submit">Sign out</button>
              </form>
            )}
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}

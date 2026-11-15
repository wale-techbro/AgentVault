import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AGENTVAULT — Give agents work. Let them earn.',
  description: 'An autonomous agent workforce with transparent NEAR escrow.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

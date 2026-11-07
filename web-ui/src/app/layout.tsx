import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WG Realtime Voice Agents — FreeSWITCH 8kHz RTP & Full-Duplex Workbench",
  description:
    "Enterprise Full-Duplex Voice Agent Workbench with FreeSWITCH mod_audio_stream, 8kHz PCMU/PCMA RTP, 60ms Barge-In, and Realtime Function Calling.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased bg-gray-100 text-gray-800">{children}</body>
    </html>
  );
}

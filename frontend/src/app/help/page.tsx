import type { Metadata } from "next";
import { HelpPageContent } from "@/components/help/HelpPageContent";

export const metadata: Metadata = {
  description: "Set up your PEPS VBC email on iPhone, iPad, Android or your preferred mail app.",
};

export default function HelpPage() { return <HelpPageContent />; }

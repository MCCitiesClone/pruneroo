import { redirect } from "next/navigation";

/**
 * Plot limits used to be their own page. They are now a section of `/at-risk`,
 * because being over a limit is one of the reasons a property is at risk and
 * splitting the two meant an inspector had to check two lists to decide what to
 * file. The route stays as a redirect so existing links keep working.
 */
export default function LimitsPage() {
  redirect("/at-risk?reason=over-limit");
}

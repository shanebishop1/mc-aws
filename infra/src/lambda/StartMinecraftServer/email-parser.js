/**
 * Parse email data from an SNS event.
 * Extracts sender email, subject, and body from the SNS message payload.
 *
 * @param {Object} event - The SNS event object
 * @returns {Object} Parsed email data with { senderEmail, subject, body } or { error } on failure
 */
export function parseEmailFromEvent(event) {
  try {
    if (!event.Records?.[0]?.Sns?.Message) {
      return { error: { statusCode: 400, body: "Invalid event structure." } };
    }

    const payload = JSON.parse(event.Records[0].Sns.Message);
    const toAddr = payload.mail?.commonHeaders?.from?.[0];
    if (!toAddr) return { error: { statusCode: 400, body: "Sender address missing." } };

    const emailMatch = toAddr.match(/<([^>]+)>/) || [null, toAddr];
    const senderEmail = (emailMatch[1] || toAddr).trim().toLowerCase();
    const subject = (payload.mail?.commonHeaders?.subject || "").toLowerCase();
    const body = payload.content ? Buffer.from(payload.content, "base64").toString("utf8").toLowerCase() : "";

    console.log("Parsed email - From:", senderEmail, "Subject:", subject);
    return { senderEmail, subject, body };
  } catch (error) {
    console.error("ERROR parsing email:", error.message);
    return { error: { statusCode: 400, body: "Error processing incoming message." } };
  }
}

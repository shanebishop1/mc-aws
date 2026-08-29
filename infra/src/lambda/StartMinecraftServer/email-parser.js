/**
 * Parse email data from an SNS event.
 * Extracts sender email, subject, body, and SES authentication verdicts from the SNS message payload.
 *
 * @param {Object} event - The SNS event object
 * @returns {Object} Parsed email data with { senderEmail, subject, body, verdicts } or { error } on failure
 */
export function parseEmailFromEvent(event) {
  try {
    if (!event.Records?.[0]?.Sns?.Message) {
      return { error: { statusCode: 400, body: "Invalid event structure." } };
    }

    const snsRecord = event.Records[0].Sns;
    const payload = JSON.parse(snsRecord.Message);
    const toAddr = payload.mail?.commonHeaders?.from?.[0];
    if (!toAddr) return { error: { statusCode: 400, body: "Sender address missing." } };

    const senderEmail = extractAngleAddress(toAddr).trim().toLowerCase();
    const subject = (payload.mail?.commonHeaders?.subject || "").toLowerCase();
    const body = payload.content ? Buffer.from(payload.content, "base64").toString("utf8").toLowerCase() : "";

    // Extract SES authentication verdicts to prevent email spoofing
    const receipt = payload.receipt || {};
    const verdicts = {
      spf: receipt.spfVerdict?.status || "UNKNOWN",
      dkim: receipt.dkimVerdict?.status || "UNKNOWN",
      dmarc: receipt.dmarcVerdict?.status || "UNKNOWN",
    };

    const eventIdentity = payload.mail?.messageId || snsRecord.MessageId || null;
    const requestedAt = payload.mail?.timestamp || snsRecord.Timestamp || null;

    return { senderEmail, subject, body, verdicts, eventIdentity, requestedAt };
  } catch {
    console.error("ERROR parsing email payload.");
    return { error: { statusCode: 400, body: "Error processing incoming message." } };
  }
}

function extractAngleAddress(address) {
  let openIndex = -1;
  for (let index = 0; index < address.length; index++) {
    const character = address[index];
    if (character === "<" && openIndex === -1) {
      openIndex = index;
    } else if (character === ">" && openIndex !== -1) {
      if (index > openIndex + 1) return address.slice(openIndex + 1, index);
      openIndex = -1;
    }
  }

  return address;
}

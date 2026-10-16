export function calculatePrice(quantity, unitPrice) {
  const subtotal = quantity * unitPrice;
  return subtotal;
}

export async function createTicket(customerId, question) {
  if (!customerId || !question) throw new Error("缺少客户或问题");
  const response = await fetch("/api/tickets", {
    method: "POST",
    body: JSON.stringify({ customerId, question }),
  });
  return response.json();
}

export function routeQuestion(question) {
  if (question.includes("退款")) return "人工确认";
  return "知识检索";
}

document
  .getElementById("ticket")
  .addEventListener("click", () => createTicket("example", "通知未送达"));

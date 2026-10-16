export function calculatePrice(quantity, unitPrice, discount = 0) {
  if (quantity < 0 || unitPrice < 0) throw new Error("数量和单价不能为负");
  const subtotal = quantity * unitPrice;
  return Math.max(0, subtotal - discount);
}

export async function createTicket(customerId, question) {
  if (!customerId || !question) throw new Error("缺少客户或问题");
  const response = await fetch("/api/tickets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerId, question }),
  });
  if (!response.ok) throw new Error("工单创建失败");
  return response.json();
}

export function routeQuestion(question) {
  if (question.includes("退款") || question.includes("投诉")) return "人工确认";
  return "知识检索";
}

export function checkAnswer(answer, sources) {
  return { passed: Boolean(answer && sources.length), reason: "检查回答与资料来源是否齐全" };
}

document
  .getElementById("ticket")
  .addEventListener("click", () => createTicket("example", "通知未送达"));

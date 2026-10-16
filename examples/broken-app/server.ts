import http from "node:http";

interface OrderItem {
  name: string;
  priceCents: number;
  qty: number;
}

interface DiscountCoupon {
  code: string;
  percentOff: number;
}

function calculateTotalCents(items: OrderItem[], coupon?: DiscountCoupon): number {
  const subtotal = items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
  // Planted bug: assumes `coupon.code` exists even when no coupon was passed!
  console.log(`Applying coupon: ${coupon!.code.toUpperCase()}`);
  const discount = coupon ? Math.round(subtotal * (coupon.percentOff / 100)) : 0;
  return subtotal - discount;
}

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  if (req.url === "/checkout") {
    try {
      const total = calculateTotalCents([{ name: "Pro Plan", priceCents: 2900, qty: 1 }]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, totalCents: total }));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Internal Server Error" }));
    }
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ready", try: "GET /checkout" }));
});

const port = Number(process.env.PORT ?? 4123);
server.listen(port, "127.0.0.1", () => {
  console.log(`Demo server listening on http://127.0.0.1:${port}`);
  if (process.env.AUTO_TRIGGER === "1") {
    http.get(`http://127.0.0.1:${port}/checkout`, () => {
      server.close();
    });
  }
});

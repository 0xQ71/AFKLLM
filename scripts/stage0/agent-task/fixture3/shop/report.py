from .models import Order
from .pricing import order_total


def build_report(orders: list[Order]) -> str:
    lines = []
    for o in sorted(orders, key=lambda o: o.day):
        lines.append(f"{o.day}  {o.id:<6} {o.customer:<10} {order_total(o):>9.2f}")
    total = sum(order_total(o) for o in orders)
    lines.append(f"Total: {total:.2f}")
    return "\n".join(lines)

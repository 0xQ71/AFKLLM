from .models import Order


def discount_rate(discount: str) -> float:
    return float(discount) / 100 if discount else 0.0


def order_total(o: Order) -> float:
    return round(o.qty * o.unit_price * (1 - discount_rate(o.discount)), 2)

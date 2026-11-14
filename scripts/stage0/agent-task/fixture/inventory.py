"""Small warehouse inventory with orders and a price report."""
from dataclasses import dataclass, field


@dataclass
class Item:
    sku: str
    name: str
    price: float
    qty: int = 0


@dataclass
class Inventory:
    items: dict = field(default_factory=dict)

    def add(self, sku, name, price, qty=0):
        if sku in self.items:
            self.items[sku].qty = qty
        else:
            self.items[sku] = Item(sku, name, price, qty)

    def total_value(self):
        return sum(i.price for i in self.items.values())

    def take(self, sku, qty):
        item = self.items[sku]
        if qty > item.qty:
            raise ValueError(f"not enough {sku}")
        item.qty -= qty
        return item.price * item.qty

    def low_stock(self, threshold=5):
        return sorted(i.sku for i in self.items.values() if i.qty < threshold)

    def apply_discount(self, percent):
        """Reduce every price by `percent` (0-100), rounded to cents."""
        raise NotImplementedError


def parse_order(line):
    """'SKU1:2, SKU2:3' -> [('SKU1', 2), ('SKU2', 3)]"""
    out = []
    for part in line.split(","):
        sku, qty = part.split(":")
        out.append((sku, qty))
    return out

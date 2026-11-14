from dataclasses import dataclass


@dataclass
class Order:
    id: str
    customer: str
    day: str          # DD.MM.YYYY
    qty: int
    unit_price: float
    discount: str     # "" or a percentage like "10%"

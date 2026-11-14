import csv
import sys

from .models import Order
from .report import build_report


def load(path: str) -> list[Order]:
    with open(path, encoding="utf-8", newline="") as f:
        return [
            Order(
                id=row["id"],
                customer=row["customer"],
                day=row["day"],
                qty=int(row["quantity"]),
                unit_price=float(row["price"]),
                discount=row["discount"].strip(),
            )
            for row in csv.DictReader(f)
        ]


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    print(build_report(load(argv[0])))
    return 0


if __name__ == "__main__":
    sys.exit(main())

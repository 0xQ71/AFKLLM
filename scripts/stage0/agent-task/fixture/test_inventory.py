import unittest

from inventory import Inventory, parse_order


def make():
    inv = Inventory()
    inv.add("A", "apple", 0.5, 10)
    inv.add("B", "bread", 2.0, 3)
    inv.add("C", "cheese", 7.25, 4)
    return inv


class InventoryTest(unittest.TestCase):
    def test_add_existing_increases_quantity(self):
        inv = make()
        inv.add("A", "apple", 0.5, 5)
        self.assertEqual(inv.items["A"].qty, 15)

    def test_total_value_counts_quantity(self):
        self.assertAlmostEqual(make().total_value(), 0.5 * 10 + 2.0 * 3 + 7.25 * 4)

    def test_take_returns_cost_of_taken_items(self):
        inv = make()
        self.assertAlmostEqual(inv.take("C", 2), 14.5)
        self.assertEqual(inv.items["C"].qty, 2)

    def test_take_too_many_raises(self):
        with self.assertRaises(ValueError):
            make().take("B", 4)

    def test_low_stock_is_inclusive_and_sorted(self):
        self.assertEqual(make().low_stock(4), ["B", "C"])

    def test_apply_discount(self):
        inv = make()
        inv.apply_discount(10)
        self.assertEqual(inv.items["A"].price, 0.45)
        self.assertEqual(inv.items["C"].price, 6.53)

    def test_apply_discount_rejects_bad_percent(self):
        with self.assertRaises(ValueError):
            make().apply_discount(120)

    def test_parse_order(self):
        self.assertEqual(parse_order("A:2, B:3"), [("A", 2), ("B", 3)])
        self.assertEqual(parse_order(" C : 1 "), [("C", 1)])


if __name__ == "__main__":
    unittest.main()

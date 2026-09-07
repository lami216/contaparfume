from pathlib import Path
p=Path('scripts/apply-product-categories.py')
s=p.read_text(encoding='utf-8')
old="'''  productId?: string;\\n  warehouseId?: string;'''"
new="'''productId?: string; warehouseId?: string;'''"
out="'''productId?: string; categoryId?: string; warehouseId?: string;'''"
second="'''  productId?: string;\\n  categoryId?: string;\\n  warehouseId?: string;'''"
if old not in s or second not in s:
    raise SystemExit('report-types patch template not found')
s=s.replace(old,new,1).replace(second,out,1)
p.write_text(s,encoding='utf-8')
print('Adjusted category patch for compact report-types interface')

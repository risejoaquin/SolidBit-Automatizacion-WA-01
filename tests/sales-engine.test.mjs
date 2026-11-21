import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {initSalesEngine,applyConfirmedSale,reverseConfirmedSale} from "../src/modules/inventory/sales-engine.js";

function fixture(){
  const db=new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE products (id INTEGER PRIMARY KEY,sku TEXT UNIQUE NOT NULL,quantity REAL NOT NULL CHECK(quantity>=0),updated_at TEXT DEFAULT CURRENT_TIMESTAMP); CREATE TABLE inventory_movements (id INTEGER PRIMARY KEY,product_id INTEGER REFERENCES products(id),delta REAL,reason TEXT);");
  db.prepare("INSERT INTO products(sku,quantity) VALUES (?,?)").run("A",10);
  db.prepare("INSERT INTO products(sku,quantity) VALUES (?,?)").run("B",5);
  initSalesEngine(db);return db;
}
const stock=(db,sku)=>db.prepare("SELECT quantity FROM products WHERE sku=?").get(sku).quantity;
test("confirmed sale decrements once, duplicate never decrements twice",()=>{
  const db=fixture();
  try {
    const input={source:"kapso",eventId:"order-101",items:[{sku:"A",quantity:2},{sku:"B",quantity:1}]};
    assert.equal(applyConfirmedSale(db,input).applied,true);
    assert.equal(stock(db,"A"),8);
    assert.equal(applyConfirmedSale(db,input).duplicate,true);
    assert.equal(stock(db,"A"),8);
    assert.equal(db.prepare("SELECT count(*) as n FROM inventory_movements").get().n,2);
    assert.throws(()=>applyConfirmedSale(db,{...input,items:[{sku:"A",quantity:3}]}),/contenido diferente/);
  }finally{db.close();}
});
test("insufficient or unknown stock rolls back all rows",()=>{
  const db=fixture();
  try {
    assert.throws(()=>applyConfirmedSale(db,{source:"kapso",eventId:"two",items:[{sku:"A",quantity:1},{sku:"B",quantity:20}]}),/insuficiente/i);
    assert.equal(stock(db,"A"),10);
    assert.equal(db.prepare("SELECT count(*) as n FROM processed_sales").get().n,0);
    assert.throws(()=>applyConfirmedSale(db,{source:"kapso",eventId:"three",items:[{sku:"ZZ",quantity:1}]}),/SKU/);
  }finally{db.close();}
});
test("reversals restore once, leaving audit log",()=>{
  const db=fixture();
  try{
    applyConfirmedSale(db,{source:"supabase",eventId:"order-10",items:[{sku:"A",quantity:3}]});
    assert.equal(stock(db,"A"),7);
    assert.equal(reverseConfirmedSale(db,{source:"supabase",eventId:"order-10"}).reversed,true);
    assert.equal(reverseConfirmedSale(db,{source:"supabase",eventId:"order-10"}).duplicate,true);
    assert.equal(stock(db,"A"),10);
    assert.equal(db.prepare("SELECT count(*) AS n FROM inventory_movements").get().n,2);
  }finally{db.close();}
});
test("reject invalid events without affecting stock",()=>{
  const db=fixture();
  try{
    for(const bad of [[{sku:"A",quantity:-1}],[{sku:"A",quantity:0}],[{sku:"A",quantity:Infinity}]]) {
      assert.throws(()=>applyConfirmedSale(db,{source:"kapso",eventId:"bad",items:bad}));
    }
    assert.equal(stock(db,"A"),10);
  }finally{db.close();}
});

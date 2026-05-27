import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  companyNameFromCheckoutSession,
  companyNameFromInvoice,
} from "./stripe-webhook-helpers.js";

describe("companyNameFromCheckoutSession", () => {
  it("usa collected_information.business_name", () => {
    const name = companyNameFromCheckoutSession({
      collected_information: { business_name: "Acme Ltda" },
      customer_details: { business_name: "Outro" },
      metadata: { company_name: "Meta" },
    });
    assert.equal(name, "Acme Ltda");
  });

  it("fallback customer_details e metadata", () => {
    assert.equal(
      companyNameFromCheckoutSession({
        customer_details: { business_name: "Cloudsys" },
      }),
      "Cloudsys"
    );
    assert.equal(
      companyNameFromCheckoutSession({
        metadata: { company_name: "Via Meta" },
      }),
      "Via Meta"
    );
  });
});

describe("companyNameFromInvoice", () => {
  it("usa metadata e customer", () => {
    assert.equal(
      companyNameFromInvoice(
        { metadata: { company_name: "Inv Meta" } },
        { business_name: "Cust Biz" }
      ),
      "Inv Meta"
    );
    assert.equal(
      companyNameFromInvoice({}, { business_name: "Cust Biz" }),
      "Cust Biz"
    );
  });
});

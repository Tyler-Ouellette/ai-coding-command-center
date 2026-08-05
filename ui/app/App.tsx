import { Page } from "@dynatrace/strato-components/layouts";
import React from "react";
import { Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { Overview } from "./pages/Overview";
import { Users } from "./pages/Users";
import { Sessions } from "./pages/Sessions";
import { Tools } from "./pages/Tools";

export const App = () => {
  return (
    <Page>
      <Page.Header>
        <Header />
      </Page.Header>
      <Page.Main>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/users" element={<Users />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/tools" element={<Tools />} />
        </Routes>
      </Page.Main>
    </Page>
  );
};

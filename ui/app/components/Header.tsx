import React from "react";
import { Link, useLocation } from "react-router-dom";
import { AppHeader } from "@dynatrace/strato-components/layouts";
import { TimeframePicker } from "../data/timeframe";

const NAV = [
  { to: "/", label: "Overview" },
  { to: "/users", label: "Users" },
  { to: "/sessions", label: "Sessions" },
  { to: "/tools", label: "Skills & Tools" },
];

export const Header = () => {
  const { pathname } = useLocation();
  return (
    <AppHeader>
      <AppHeader.Navigation>
        <AppHeader.Logo as={Link} to="/" />
        {NAV.map((item) => (
          <AppHeader.NavigationItem
            key={item.to}
            as={Link}
            to={item.to}
            isSelected={pathname === item.to}
          >
            {item.label}
          </AppHeader.NavigationItem>
        ))}
      </AppHeader.Navigation>
      <AppHeader.ActionItems>
        <TimeframePicker />
      </AppHeader.ActionItems>
    </AppHeader>
  );
};
